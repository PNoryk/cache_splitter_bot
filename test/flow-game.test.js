import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './helpers/d1.js';
import {
  BOT, GROUP, world, cmd, press, of, startGame as startGameBy,
} from './helpers/updates.js';
import { handleUpdate } from '../platform/handlers.js';
import worker from '../platform/worker.js';
import { loadGame, findOpenGame, setStatus } from '../platform/db.js';
import { TelegramError } from '../platform/telegram.js';

const A = { id: 1, first_name: 'Аня', last_name: 'Ким' };
const B = { id: 2, first_name: 'Боря' };
const C = { id: 3, first_name: 'Вера' };

/**
 * Start a game in GROUP by A.
 * @param {ReturnType<typeof world>} w
 * @returns {Promise<number>}
 */
const startGame = (w) => startGameBy(w, A);

test('/game creates a game message, also with bot suffix elsewhere', async () => {
  const w = world();
  await handleUpdate(cmd(w.uid(), '/game 1000 50', A), w.ctx);
  const sent = of(w.api, 'sendMessage');
  assert.ok(sent[0].text.startsWith('🃏 Игра · 1000 фишек = 50,00'));
  assert.equal(sent[0].chat_id, GROUP);
  const g = await loadGame(w.db, await findOpenGame(w.db, GROUP));
  assert.equal(g.messageId, 100);
  await handleUpdate(cmd(w.uid(), '/game@Cash_Bot 1000 50', A, -200), w.ctx);
  assert.ok(of(w.api, 'sendMessage')[1].text.startsWith('🃏 Игра'));
  assert.equal(of(w.api, 'sendMessage')[1].chat_id, -200);
});

test('command for another bot is ignored', async () => {
  const w = world();
  await handleUpdate(cmd(w.uid(), '/game@other_bot 1000 50', A), w.ctx);
  assert.equal(w.api.calls.length, 0);
});

test('/game without args gives hint; second /game says already', async () => {
  const w = world();
  await handleUpdate(cmd(w.uid(), '/game', A), w.ctx);
  assert.ok(of(w.api, 'sendMessage')[0].text.includes('/game 1000 50'));
  assert.equal(await findOpenGame(w.db, GROUP), null);
  await startGame(w);
  await handleUpdate(cmd(w.uid(), '/game 500 10', B), w.ctx);
  const last = of(w.api, 'sendMessage').at(-1);
  assert.ok(last.text.includes('Уже идёт игра'));
  assert.equal(last.reply_to_message_id, 101);
});

test('join by two users; repeat join says already', async () => {
  const w = world();
  const id = await startGame(w);
  await handleUpdate(press(w.uid(), `${id}:join`, A), w.ctx);
  await handleUpdate(press(w.uid(), `${id}:join`, B), w.ctx);
  let g = await loadGame(w.db, id);
  assert.deepEqual(g.players.map((p) => p.name), ['Аня Ким', 'Боря']);
  assert.equal(g.entries.length, 2);
  await handleUpdate(press(w.uid(), `${id}:join`, A), w.ctx);
  g = await loadGame(w.db, id);
  assert.equal(g.entries.length, 2);
  assert.equal(of(w.api, 'answerCallbackQuery').at(-1).text, 'Ты уже в игре');
  assert.ok(of(w.api, 'editMessageText').length >= 2);
});

test('same update_id twice gives one rebuy', async () => {
  const w = world();
  const id = await startGame(w);
  await handleUpdate(press(w.uid(), `${id}:join`, A), w.ctx);
  const u = press(w.uid(), `${id}:rebuy`, A);
  await handleUpdate(u, w.ctx);
  await handleUpdate(u, w.ctx);
  assert.equal((await loadGame(w.db, id)).entries.length, 2);
});

test('rebuy: self, then chooser with guest, foreign target refused', async () => {
  const w = world();
  const id = await startGame(w);
  await handleUpdate(press(w.uid(), `${id}:rebuy`, A), w.ctx);
  assert.equal(of(w.api, 'answerCallbackQuery').at(-1).text, 'Сначала „Я в игре“');
  await handleUpdate(press(w.uid(), `${id}:join`, A), w.ctx);
  await handleUpdate(press(w.uid(), `${id}:join`, B), w.ctx);
  await handleUpdate(press(w.uid(), `${id}:rebuy`, A), w.ctx);
  let g = await loadGame(w.db, id);
  assert.equal(g.entries.length, 3);
  assert.equal(g.entries[2].kind, 'rebuy');
  assert.equal(g.entries[2].playerId, g.players[0].id);
  w.api.calls.length = 0;
  await handleUpdate(press(w.uid(), `${id}:guest`, A), w.ctx);
  const prompt = of(w.api, 'sendMessage')[0];
  assert.equal(prompt.text, `Имя гостя для игры #${id}? Ответьте на это сообщение.`);
  assert.deepEqual(prompt.reply_markup, { force_reply: true, input_field_placeholder: 'Имя гостя' });
});

test('guest via ForceReply, rebuy chooser, rb for guest and foreign refused', async () => {
  const w = world();
  const id = await startGame(w);
  await handleUpdate(press(w.uid(), `${id}:join`, A), w.ctx);
  await handleUpdate(press(w.uid(), `${id}:join`, B), w.ctx);
  const reply = cmd(w.uid(), '  Дима  ', A);
  reply.message.reply_to_message = {
    from: { is_bot: true },
    text: `Имя гостя для игры #${id}? Ответьте на это сообщение.`,
  };
  await handleUpdate(reply, w.ctx);
  let g = await loadGame(w.db, id);
  const guest = g.players[2];
  assert.equal(guest.name, 'Дима');
  assert.equal(guest.tgUserId, null);
  assert.equal(guest.addedBy, A.id);
  // chooser
  w.api.calls.length = 0;
  await handleUpdate(press(w.uid(), `${id}:rebuy`, A), w.ctx);
  const chooser = of(w.api, 'sendMessage')[0];
  assert.equal(chooser.reply_to_message_id, 100);
  assert.ok(chooser.text.includes('Кому'));
  w.api.calls.length = 0;
  await handleUpdate(press(w.uid(), `${id}:rb:${guest.id}`, A, GROUP, 555), w.ctx);
  g = await loadGame(w.db, id);
  const e = g.entries.at(-1);
  assert.deepEqual([e.playerId, e.kind, e.createdBy], [guest.id, 'rebuy', A.id]);
  assert.deepEqual(of(w.api, 'deleteMessage'), [{ chat_id: GROUP, message_id: 555 }]);
  // foreign tg player refused
  const n = g.entries.length;
  await handleUpdate(press(w.uid(), `${id}:rb:${g.players[1].id}`, A), w.ctx);
  assert.equal((await loadGame(w.db, id)).entries.length, n);
});

test('undo cancels only own entry', async () => {
  const w = world();
  const id = await startGame(w);
  await handleUpdate(press(w.uid(), `${id}:undo`, C), w.ctx);
  assert.equal(of(w.api, 'answerCallbackQuery').at(-1).text, 'Нечего отменять');
  await handleUpdate(press(w.uid(), `${id}:join`, A), w.ctx);
  await handleUpdate(press(w.uid(), `${id}:join`, B), w.ctx);
  await handleUpdate(press(w.uid(), `${id}:rebuy`, B), w.ctx);
  await handleUpdate(press(w.uid(), `${id}:undo`, A), w.ctx);
  let g = await loadGame(w.db, id);
  assert.deepEqual(g.entries.map((e) => e.cancelled), [true, false, false]);
  await handleUpdate(press(w.uid(), `${id}:undo`, A), w.ctx);
  g = await loadGame(w.db, id);
  assert.equal(g.entries.filter((e) => !e.cancelled).length, 2);
});

test('/start join_<id> in private adds player and messages them', async () => {
  const w = world();
  const id = await startGame(w);
  w.api.calls.length = 0;
  await handleUpdate(cmd(w.uid(), `/start join_${id}`, B, B.id), w.ctx);
  const g = await loadGame(w.db, id);
  assert.equal(g.players.length, 1);
  const dm = of(w.api, 'sendMessage')[0];
  assert.equal(dm.chat_id, B.id);
  assert.ok(JSON.stringify(dm.reply_markup).includes('+ Докуп'));
  const edit = of(w.api, 'editMessageText')[0];
  assert.equal(edit.chat_id, GROUP);
  assert.equal(edit.message_id, 100);
});

test('/start without payload shows help; finished game refuses join', async () => {
  const w = world();
  await handleUpdate(cmd(w.uid(), '/start', B, B.id), w.ctx);
  assert.ok(of(w.api, 'sendMessage')[0].text.length > 0);
  const id = await startGame(w);
  await setStatus(w.db, id, ['active'], 'cancelled');
  await handleUpdate(cmd(w.uid(), `/start join_${id}`, B, B.id), w.ctx);
  assert.equal(of(w.api, 'sendMessage').at(-1).text, 'Игра уже закончена');
  assert.equal((await loadGame(w.db, id)).players.length, 0);
});

test('buttons on a cancelled game answer and change nothing', async () => {
  const w = world();
  const id = await startGame(w);
  await handleUpdate(press(w.uid(), `${id}:join`, A), w.ctx);
  await setStatus(w.db, id, ['active'], 'cancelled');
  w.api.calls.length = 0;
  await handleUpdate(press(w.uid(), `${id}:rebuy`, A), w.ctx);
  assert.equal((await loadGame(w.db, id)).entries.length, 1);
  assert.deepEqual(of(w.api, 'answerCallbackQuery'), [
    { callback_query_id: 'cq' + (w.uid() - 1), text: 'Игра уже закончена', show_alert: false },
  ]);
  assert.equal(of(w.api, 'editMessageText').length, 0);
});

test('refresh falls back to a new message when edit target is gone', async () => {
  const w = world();
  const id = await startGame(w);
  const real = w.api.call;
  w.api.call = async (method, params) => {
    if (method === 'editMessageText') {
      throw new TelegramError('Bad Request: message to edit not found', 400);
    }
    return real(method, params);
  };
  await handleUpdate(press(w.uid(), `${id}:join`, A), w.ctx);
  const g = await loadGame(w.db, id);
  assert.notEqual(g.messageId, 100);
  assert.equal(g.messageId, w.api.nextMessageId - 1);
});

test('worker: 405, 403, and 200 with logged error on bad JSON', async () => {
  const env = { BOT_TOKEN: 't', WEBHOOK_SECRET: 's', BOT_USERNAME: BOT, DB: createD1() };
  const mk = (/** @type {any} */ init) => new Request('https://x.test/', init);
  assert.equal((await worker.fetch(mk({ method: 'GET' }), env)).status, 405);
  assert.equal((await worker.fetch(mk({ method: 'POST', body: '{}' }), env)).status, 403);
  const logged = [];
  const orig = console.error;
  console.error = (/** @type {any[]} */ ...a) => logged.push(a);
  try {
    const res = await worker.fetch(
      mk({
        method: 'POST',
        body: '{bad',
        headers: { 'X-Telegram-Bot-Api-Secret-Token': 's' },
      }),
      env,
    );
    assert.equal(res.status, 200);
  } finally {
    console.error = orig;
  }
  assert.equal(logged.length, 1);
});

test('double tap on rebuy chooser writes one rebuy and refreshes once', async () => {
  const w = world();
  const id = await startGame(w);
  await handleUpdate(press(w.uid(), `${id}:join`, A), w.ctx);
  const reply = cmd(w.uid(), 'Дима', A);
  reply.message.reply_to_message = {
    from: { is_bot: true }, text: `Имя гостя для игры #${id}? Ответьте на это сообщение.`,
  };
  await handleUpdate(reply, w.ctx);
  const guest = (await loadGame(w.db, id)).players[1];
  const before = (await loadGame(w.db, id)).entries.length;
  w.api.calls.length = 0;
  await handleUpdate(press(w.uid(), `${id}:rb:${guest.id}`, A, GROUP, 555), w.ctx);
  await handleUpdate(press(w.uid(), `${id}:rb:${guest.id}`, A, GROUP, 555), w.ctx);
  assert.equal((await loadGame(w.db, id)).entries.length, before + 1);
  assert.equal(of(w.api, 'editMessageText').length, 1);
  assert.equal(of(w.api, 'answerCallbackQuery').length, 2);
});

test('active-only button on a counting game explains', async () => {
  const w = world();
  const id = await startGame(w);
  await setStatus(w.db, id, ['active'], 'counting');
  w.api.calls.length = 0;
  await handleUpdate(press(w.uid(), `${id}:rebuy`, A), w.ctx);
  assert.equal(
    of(w.api, 'answerCallbackQuery')[0].text,
    'Идёт подсчёт — сначала «Вернуться в игру»',
  );
});

test('worker: unset or empty secret rejects everything', async () => {
  const mk = () => new Request('https://x.test/', { method: 'POST', body: '{}' });
  const env = { BOT_TOKEN: 't', BOT_USERNAME: BOT, DB: createD1() };
  assert.equal((await worker.fetch(mk(), env)).status, 403);
  assert.equal((await worker.fetch(mk(), { ...env, WEBHOOK_SECRET: '' })).status, 403);
  const req = new Request('https://x.test/', {
    method: 'POST', body: '{}', headers: { 'X-Telegram-Bot-Api-Secret-Token': '' },
  });
  assert.equal((await worker.fetch(req, { ...env, WEBHOOK_SECRET: '' })).status, 403);
});

/**
 * Add a guest through the ForceReply prompt.
 * @param {ReturnType<typeof world>} w
 * @param {number} id
 * @param {string} name
 * @param {any} by
 * @returns {Promise<void>}
 */
async function addGuest(w, id, name, by) {
  const reply = cmd(w.uid(), name, by);
  reply.message.reply_to_message = {
    from: { is_bot: true }, text: `Имя гостя для игры #${id}? Ответьте на это сообщение.`,
  };
  await handleUpdate(reply, w.ctx);
}

test('undoing the own buyin leaves the game; join again rejoins', async () => {
  const w = world();
  const id = await startGame(w);
  for (const u of [A, B, C]) await handleUpdate(press(w.uid(), `${id}:join`, u), w.ctx);
  await handleUpdate(press(w.uid(), `${id}:undo`, C), w.ctx);
  assert.ok(!of(w.api, 'editMessageText').at(-1).text.includes('Вера'));
  await handleUpdate(press(w.uid(), `${id}:rebuy`, C), w.ctx);
  assert.equal(of(w.api, 'answerCallbackQuery').at(-1).text, 'Сначала „Я в игре“');
  w.api.calls.length = 0;
  await handleUpdate(press(w.uid(), `${id}:join`, C), w.ctx);
  const g = await loadGame(w.db, id);
  assert.equal(g.players.length, 3);
  assert.deepEqual(
    g.entries.filter((e) => e.playerId === g.players[2].id).map((e) => [e.kind, e.cancelled]),
    [['buyin', true], ['buyin', false]],
  );
  assert.equal(of(w.api, 'answerCallbackQuery')[0].text, undefined);
  assert.ok(of(w.api, 'editMessageText').at(-1).text.includes('Вера · 1 закуп'));
});

test('repeat join also refreshes the game message', async () => {
  const w = world();
  const id = await startGame(w);
  await handleUpdate(press(w.uid(), `${id}:join`, A), w.ctx);
  w.api.calls.length = 0;
  await handleUpdate(press(w.uid(), `${id}:join`, A), w.ctx);
  assert.equal(of(w.api, 'answerCallbackQuery')[0].text, 'Ты уже в игре');
  assert.equal(of(w.api, 'editMessageText').length, 1);
  assert.equal((await loadGame(w.db, id)).entries.length, 1);
});

test('guest name equal to a player in the game is refused', async () => {
  const w = world();
  const id = await startGame(w);
  await handleUpdate(press(w.uid(), `${id}:join`, B), w.ctx);
  await addGuest(w, id, 'Дима', A);
  for (const name of ['  боря ', 'ДИМА']) {
    w.api.calls.length = 0;
    await addGuest(w, id, name, A);
    const sent = of(w.api, 'sendMessage');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].text, 'Такое имя уже есть, введите другое');
    assert.equal(sent[0].chat_id, GROUP);
    assert.ok(sent[0].reply_to_message_id > 0);
  }
  assert.deepEqual((await loadGame(w.db, id)).players.map((p) => p.name), ['Боря', 'Дима']);
  // a name that only shares a prefix is fine
  await addGuest(w, id, 'Димон', A);
  assert.equal((await loadGame(w.db, id)).players.length, 3);
});

test('/start join_<id> during counting is refused', async () => {
  const w = world();
  const id = await startGame(w);
  await handleUpdate(press(w.uid(), `${id}:join`, A), w.ctx);
  await handleUpdate(press(w.uid(), `${id}:end`, A), w.ctx);
  w.api.calls.length = 0;
  await handleUpdate(cmd(w.uid(), `/start join_${id}`, B, B.id), w.ctx);
  assert.deepEqual(of(w.api, 'sendMessage'), [
    { chat_id: B.id, text: 'Идёт подсчёт — присоединиться уже нельзя' },
  ]);
  assert.equal((await loadGame(w.db, id)).players.length, 1);
});

test('/game with too many chips or too high price gives the hint', async () => {
  const w = world();
  await handleUpdate(cmd(w.uid(), '/game 1000000001 50', A), w.ctx);
  await handleUpdate(cmd(w.uid(), '/game 1000 1000001', A), w.ctx);
  assert.equal(await findOpenGame(w.db, GROUP), null);
  for (const m of of(w.api, 'sendMessage')) assert.ok(m.text.includes('/game 1000 50'));
});

/**
 * Make the game finish (settled) right before the first statement whose SQL starts with prefix,
 * as if a concurrent request won the race.
 * @param {ReturnType<typeof world>} w
 * @param {number} id
 * @param {string} prefix
 * @returns {void}
 */
function finishBefore(w, id, prefix) {
  const db = w.ctx.db;
  let armed = true;
  w.ctx.db = {
    ...db,
    prepare: (/** @type {string} */ sql) => {
      if (armed && sql.startsWith(prefix)) {
        armed = false;
        db.prepare("UPDATE games SET status = 'settled' WHERE id = ?").bind(id).runSync();
      }
      return db.prepare(sql);
    },
  };
}

test('rebuy that loses the race to settlement writes nothing and says so', async () => {
  const w = world();
  const id = await startGame(w);
  await handleUpdate(press(w.uid(), `${id}:join`, A), w.ctx);
  finishBefore(w, id, 'INSERT INTO entries');
  w.api.calls.length = 0;
  await handleUpdate(press(w.uid(), `${id}:rebuy`, A), w.ctx);
  assert.equal((await loadGame(w.db, id)).entries.length, 1);
  assert.equal(of(w.api, 'answerCallbackQuery')[0].text, 'Игра уже закончена');
  assert.equal(of(w.api, 'editMessageText').length, 0);
});

test('/price that loses the race to settlement changes nothing and says so', async () => {
  const w = world();
  const id = await startGame(w);
  finishBefore(w, id, 'UPDATE games SET chips_per_buyin');
  w.api.calls.length = 0;
  await handleUpdate(cmd(w.uid(), '/price 500 10', A), w.ctx);
  assert.equal((await loadGame(w.db, id)).priceKop, 5000);
  assert.deepEqual(of(w.api, 'sendMessage').map((m) => m.text), ['Игра уже закончена']);
});

test('stack that loses the race to settlement is not written', async () => {
  const w = world();
  const id = await startGame(w);
  await handleUpdate(press(w.uid(), `${id}:join`, A), w.ctx);
  await handleUpdate(press(w.uid(), `${id}:end`, A), w.ctx);
  const g = await loadGame(w.db, id);
  finishBefore(w, id, 'INSERT INTO stacks');
  w.api.calls.length = 0;
  const m = cmd(w.uid(), '1000', A);
  m.message.reply_to_message = { message_id: g.countMessageId };
  await handleUpdate(m, w.ctx);
  assert.equal((await loadGame(w.db, id)).stacks.length, 0);
  assert.deepEqual(of(w.api, 'sendMessage').map((x) => x.text), ['Игра уже закончена']);
});

test('/help answers in group (with or without @bot) and in private with the same text', async () => {
  const w = world();
  await handleUpdate(cmd(w.uid(), '/help', B), w.ctx);
  await handleUpdate(cmd(w.uid(), `/help@${BOT}`, B), w.ctx);
  await handleUpdate(cmd(w.uid(), '/help', B, B.id), w.ctx);
  await handleUpdate(cmd(w.uid(), '/start', B, B.id), w.ctx);
  const sent = of(w.api, 'sendMessage');
  assert.deepEqual(sent.map((m) => m.chat_id), [GROUP, GROUP, B.id, B.id]);
  assert.equal(new Set(sent.map((m) => m.text)).size, 1);
  for (const part of ['/game 1000 50', '/price', 'Ответьте на сообщение подсчёта']) {
    assert.ok(sent[0].text.includes(part), part);
  }
});
