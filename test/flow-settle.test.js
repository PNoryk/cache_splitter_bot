import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  world, cmd, press, of, GROUP, startGame,
} from './helpers/updates.js';
import { handleUpdate } from '../platform/handlers.js';
import { loadGame } from '../platform/db.js';
import { settlement } from '../core/game.js';

const P = { id: 1, first_name: 'Паша' };
const S = { id: 2, first_name: 'Саша' };
const V = { id: 3, first_name: 'Вася' };
const L = { id: 4, first_name: 'Валера' };

/**
 * Join users into the game.
 * @param {any} w
 * @param {number} id
 * @param {any[]} users
 * @returns {Promise<void>}
 */
async function join(w, id, users) {
  for (const u of users) await handleUpdate(press(w.uid(), `${id}:join`, u), w.ctx);
}

/**
 * Add a guest through the ForceReply prompt.
 * @param {any} w
 * @param {number} id
 * @param {string} name
 * @param {any} by
 * @returns {Promise<void>}
 */
async function guest(w, id, name, by) {
  const reply = cmd(w.uid(), name, by);
  reply.message.reply_to_message = {
    from: { is_bot: true }, text: `Имя гостя для игры #${id}? Ответьте на это сообщение.`,
  };
  await handleUpdate(reply, w.ctx);
}

/**
 * Stack input as a reply to the count message.
 * @param {any} w
 * @param {number} id
 * @param {string} text
 * @param {any} from
 * @returns {Promise<void>}
 */
async function stack(w, id, text, from) {
  const g = await loadGame(w.db, id);
  const u = cmd(w.uid(), text, from);
  u.message.reply_to_message = { message_id: g.countMessageId, from: { is_bot: true } };
  await handleUpdate(u, w.ctx);
}

/**
 * Game with Паша, Саша and the guest Дима; Паша rebought once; counting started.
 * @param {any} w
 * @returns {Promise<number>}
 */
async function countingGame(w) {
  const id = await startGame(w, P);
  await join(w, id, [P]);
  await guest(w, id, 'Дима', P);
  await join(w, id, [S]);
  const pasha = (await loadGame(w.db, id)).players[0];
  await handleUpdate(press(w.uid(), `${id}:rb:${pasha.id}`, P, GROUP, 555), w.ctx);
  await handleUpdate(press(w.uid(), `${id}:end`, P), w.ctx);
  return id;
}

test('end: counting message, game message without rebuy buttons', async () => {
  const w = world();
  const id = await startGame(w, P);
  await join(w, id, [P]);
  w.api.calls.length = 0;
  await handleUpdate(press(w.uid(), `${id}:end`, P), w.ctx);
  const g = await loadGame(w.db, id);
  assert.equal(g.status, 'counting');
  const sent = of(w.api, 'sendMessage');
  assert.ok(sent[0].text.startsWith('🧮 Подсчёт'));
  assert.equal(g.countMessageId, 101);
  const edit = of(w.api, 'editMessageText').at(-1);
  assert.equal(edit.message_id, 100);
  assert.equal(JSON.stringify(edit.reply_markup).includes('Докуп'), false);
});

test('full game: stacks, zero button, result zeroes the balances', async () => {
  const w = world();
  const id = await countingGame(w);
  await stack(w, id, '1370', P);
  await stack(w, id, 'Дима 2630', P);
  let g = await loadGame(w.db, id);
  const edits = of(w.api, 'editMessageText').filter((e) => e.message_id === g.countMessageId);
  assert.ok(edits.at(-1).text.includes('Дима 2630 (ввёл Паша)'));
  assert.ok(edits.at(-1).text.includes('Паша  1370 ✓'));
  assert.equal(of(w.api, 'sendMessage').at(-1).text.startsWith('✅'), false);
  await handleUpdate(press(w.uid(), `${id}:zero`, S, GROUP, g.countMessageId), w.ctx);
  g = await loadGame(w.db, id);
  assert.equal(g.status, 'settled');
  const result = of(w.api, 'sendMessage').at(-1);
  assert.equal(result.chat_id, GROUP);
  assert.ok(result.text.startsWith('✅ Итог'));
  const s = settlement(g, { split: false, round: false });
  assert.deepEqual(s.balances, [-3150, 8150, -5000]);
  assert.equal(s.transfers.length, 2);
  const net = s.balances.slice();
  for (const t of s.transfers) {
    net[g.players.findIndex((p) => p.id === t.from)] += t.kop;
    net[g.players.findIndex((p) => p.id === t.to)] -= t.kop;
  }
  assert.deepEqual(net, [0, 0, 0]);
  assert.equal(result.text.split('\n').filter((l) => l.includes('→')).length, 2);
});

test('discrepancy: warning, split settles with zero-sum balances', async () => {
  const w = world();
  const id = await countingGame(w);
  await stack(w, id, '1370', P);
  await stack(w, id, 'Дима 3630', P);
  await stack(w, id, '0', S);
  const warn = of(w.api, 'sendMessage').at(-1);
  assert.ok(warn.text.includes('расхождение +1000 (50,00)'));
  assert.equal((await loadGame(w.db, id)).status, 'counting');
  await handleUpdate(press(w.uid(), `${id}:split`, P, GROUP, 200), w.ctx);
  const g = await loadGame(w.db, id);
  assert.equal(g.status, 'settled');
  assert.ok(of(w.api, 'sendMessage').at(-1).text.startsWith('✅ Итог'));
  const s = settlement(g, { split: true, round: false });
  assert.equal(s.balances.reduce((a, b) => a + b, 0), 0);
  // a second press does not send another result
  const n = of(w.api, 'sendMessage').length;
  await handleUpdate(press(w.uid(), `${id}:split`, P, GROUP, 200), w.ctx);
  assert.equal(of(w.api, 'sendMessage').length, n);
});

test('fix: rebuy for Саша re-runs reconciliation and settles', async () => {
  const w = world();
  const id = await countingGame(w);
  await stack(w, id, '1370', P);
  await stack(w, id, 'Дима 3630', P);
  await stack(w, id, '0', S);
  // Саша is the only target for her (the guest Дима is also a target) -> chooser
  w.api.calls.length = 0;
  await handleUpdate(press(w.uid(), `${id}:fix`, S, GROUP, 200), w.ctx);
  const chooser = of(w.api, 'sendMessage')[0];
  assert.ok(chooser.text.includes('Кому'));
  const g0 = await loadGame(w.db, id);
  await handleUpdate(press(w.uid(), `${id}:rb:${g0.players[2].id}`, S, GROUP, 300), w.ctx);
  const g = await loadGame(w.db, id);
  assert.equal(g.status, 'settled');
  assert.ok(of(w.api, 'sendMessage').at(-1).text.startsWith('✅ Итог'));
});

test('fix with a single target records the rebuy directly', async () => {
  const w = world();
  const id = await startGame(w, P);
  await join(w, id, [P, S]);
  await handleUpdate(press(w.uid(), `${id}:end`, P), w.ctx);
  await stack(w, id, '1000', P);
  await stack(w, id, '2000', S);
  assert.ok(of(w.api, 'sendMessage').at(-1).text.includes('расхождение +1000'));
  await handleUpdate(press(w.uid(), `${id}:fix`, S), w.ctx);
  const g = await loadGame(w.db, id);
  assert.equal(g.entries.length, 3);
  assert.equal(g.status, 'settled');
});

test('round and exact edit the pressed message; split flag from discrepancy', async () => {
  const w = world();
  const id = await startGame(w, P);
  await join(w, id, [P, S, V]);
  await handleUpdate(press(w.uid(), `${id}:end`, P), w.ctx);
  await stack(w, id, '1331', P);
  await stack(w, id, '1000', S);
  await stack(w, id, '669', V);
  const g = await loadGame(w.db, id);
  assert.equal(g.status, 'settled');
  w.api.calls.length = 0;
  await handleUpdate(press(w.uid(), `${id}:round`, P, GROUP, 777), w.ctx);
  const r = of(w.api, 'editMessageText')[0];
  assert.deepEqual([r.chat_id, r.message_id], [GROUP, 777]);
  assert.ok(JSON.stringify(r.reply_markup).includes('Точно'));
  assert.ok(!/\d,\d\d/.test(r.text.split('\n').slice(2).join(' ')));
  await handleUpdate(press(w.uid(), `${id}:exact`, P, GROUP, 777), w.ctx);
  const e = of(w.api, 'editMessageText')[1];
  assert.ok(JSON.stringify(e.reply_markup).includes('Округлить'));
  assert.ok(/\d,\d\d/.test(e.text));
});

test('garbage input is answered and writes nothing', async () => {
  const w = world();
  const id = await startGame(w, P);
  await join(w, id, [P, V, L]);
  await handleUpdate(press(w.uid(), `${id}:end`, P), w.ctx);
  /** @type {[string, string][]} */
  const cases = [
    ['1370.5', 'Не понял. Число фишек, или «Имя число»'],
    ['Петя 100', 'Нет игрока Петя'],
    ['Ва 100', 'Уточни имя: Вася, Валера'],
  ];
  for (const [text, reply] of cases) {
    w.api.calls.length = 0;
    await stack(w, id, text, P);
    const sent = of(w.api, 'sendMessage');
    assert.equal(sent[0].text, reply);
    assert.ok(sent[0].reply_to_message_id > 0);
  }
  assert.equal((await loadGame(w.db, id)).stacks.length, 0);
  // a non-player entering their own stack
  w.api.calls.length = 0;
  await stack(w, id, '100', S);
  assert.equal(of(w.api, 'sendMessage')[0].text, 'Ты не в игре');
});

test('stack from a private chat counts; without a counting game it is ignored', async () => {
  const w = world();
  const id = await startGame(w, P);
  await join(w, id, [P, S]);
  w.api.calls.length = 0;
  await handleUpdate(cmd(w.uid(), '500', S, S.id), w.ctx);
  assert.equal(w.api.calls.length, 0);
  await handleUpdate(press(w.uid(), `${id}:end`, P), w.ctx);
  await handleUpdate(cmd(w.uid(), '500', S, S.id), w.ctx);
  const g = await loadGame(w.db, id);
  assert.deepEqual(g.stacks.map((s) => [s.chips, s.enteredBy]), [[500, S.id]]);
});

test('back returns to active, end again keeps the stacks', async () => {
  const w = world();
  const id = await startGame(w, P);
  await join(w, id, [P, S]);
  await handleUpdate(press(w.uid(), `${id}:end`, P), w.ctx);
  await stack(w, id, '700', P);
  await handleUpdate(press(w.uid(), `${id}:back`, P), w.ctx);
  assert.equal((await loadGame(w.db, id)).status, 'active');
  await handleUpdate(press(w.uid(), `${id}:end`, P), w.ctx);
  const g = await loadGame(w.db, id);
  assert.equal(g.status, 'counting');
  assert.equal(g.stacks.length, 1);
  assert.ok(of(w.api, 'sendMessage').at(-1).text.includes('Паша  700 ✓'));
});

test('a player out of the game does not block reconciliation', async () => {
  const w = world();
  const id = await startGame(w, P);
  await join(w, id, [P, S, V]);
  await handleUpdate(press(w.uid(), `${id}:undo`, V), w.ctx);
  await handleUpdate(press(w.uid(), `${id}:end`, P), w.ctx);
  const count = of(w.api, 'sendMessage').at(-1).text;
  assert.ok(!count.includes('Вася'));
  await stack(w, id, '1500', P);
  await stack(w, id, '500', S);
  assert.equal((await loadGame(w.db, id)).status, 'settled');
  assert.ok(of(w.api, 'sendMessage').at(-1).text.includes('Саша → Паша 25,00'));
});

test('name clarification lists only matching players in the game', async () => {
  const w = world();
  const id = await startGame(w, P);
  await join(w, id, [P, V, L]);
  await guest(w, id, 'Ваня', P);
  await handleUpdate(press(w.uid(), `${id}:undo`, L), w.ctx);
  await handleUpdate(press(w.uid(), `${id}:end`, P), w.ctx);
  w.api.calls.length = 0;
  await stack(w, id, 'ва 100', P);
  assert.equal(of(w.api, 'sendMessage')[0].text, 'Уточни имя: Вася, Ваня');
  await stack(w, id, 'вал 100', P);
  assert.equal(of(w.api, 'sendMessage')[1].text, 'Нет игрока вал');
});

test('end with all stacks already present settles at once', async () => {
  const w = world();
  const id = await startGame(w, P);
  await join(w, id, [P, S]);
  await handleUpdate(press(w.uid(), `${id}:end`, P), w.ctx);
  await stack(w, id, '1000', P);
  await stack(w, id, '2000', S);
  assert.ok(of(w.api, 'sendMessage').at(-1).text.includes('расхождение +1000'));
  // back to the game, the forgotten rebuy is added, the stacks stay
  await handleUpdate(press(w.uid(), `${id}:back`, P), w.ctx);
  await handleUpdate(press(w.uid(), `${id}:rebuy`, S), w.ctx);
  w.api.calls.length = 0;
  await handleUpdate(press(w.uid(), `${id}:end`, P), w.ctx);
  assert.equal((await loadGame(w.db, id)).status, 'settled');
  const sent = of(w.api, 'sendMessage').map((m) => m.text);
  assert.equal(sent.length, 2);
  assert.ok(sent[0].startsWith('🧮 Подсчёт'));
  assert.ok(sent[1].startsWith('✅ Итог'));
});

test('end with all stacks present and a discrepancy warns at once', async () => {
  const w = world();
  const id = await startGame(w, P);
  await join(w, id, [P, S]);
  await handleUpdate(press(w.uid(), `${id}:end`, P), w.ctx);
  await stack(w, id, '1000', P);
  await stack(w, id, '2000', S);
  await handleUpdate(press(w.uid(), `${id}:back`, P), w.ctx);
  w.api.calls.length = 0;
  await handleUpdate(press(w.uid(), `${id}:end`, P), w.ctx);
  assert.equal((await loadGame(w.db, id)).status, 'counting');
  assert.ok(of(w.api, 'sendMessage').at(-1).text.includes('в банке 2000 — расхождение +1000'));
});

test('/price while counting with all stacks reconciles against the new bank', async () => {
  const w = world();
  const id = await startGame(w, P);
  await join(w, id, [P, S]);
  await handleUpdate(press(w.uid(), `${id}:end`, P), w.ctx);
  await stack(w, id, '1500', P);
  await stack(w, id, '1000', S);
  assert.ok(of(w.api, 'sendMessage').at(-1).text.includes('в банке 2000'));
  await handleUpdate(cmd(w.uid(), '/price 1100 50', P), w.ctx);
  const texts = of(w.api, 'sendMessage').map((m) => m.text);
  assert.ok(texts.some((t) => t.includes('На столе 2500, в банке 2200 — расхождение +300')));
  assert.equal((await loadGame(w.db, id)).status, 'counting');
  await handleUpdate(cmd(w.uid(), '/price 1250 50', P), w.ctx);
  assert.equal((await loadGame(w.db, id)).status, 'settled');
  assert.ok(of(w.api, 'sendMessage').some((m) => m.text.startsWith('✅ Итог')));
});

test('result lost on send: game is settled and the Итог button re-sends it', async () => {
  const w = world();
  const id = await startGame(w, P);
  await join(w, id, [P, S]);
  await handleUpdate(press(w.uid(), `${id}:end`, P), w.ctx);
  await stack(w, id, '1500', P);
  const real = w.api.call;
  w.api.call = async (method, params) => {
    if (method === 'sendMessage' && params.text.startsWith('✅ Итог')) {
      throw new Error('network down');
    }
    return real(method, params);
  };
  await assert.rejects(stack(w, id, '500', S), /network down/);
  w.api.call = real;
  assert.equal((await loadGame(w.db, id)).status, 'settled');
  const edit = of(w.api, 'editMessageText').at(-1);
  assert.equal(edit.message_id, 100);
  assert.deepEqual(edit.reply_markup.inline_keyboard, [[{ text: 'Итог', callback_data: `${id}:result` }]]);
  w.api.calls.length = 0;
  await handleUpdate(press(w.uid(), `${id}:result`, S), w.ctx);
  const sent = of(w.api, 'sendMessage');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, GROUP);
  assert.equal(sent[0].text, '✅ Итог\n\nСаша → Паша 25,00');
  assert.deepEqual(sent[0].reply_markup.inline_keyboard, [[{ text: 'Округлить', callback_data: `${id}:round` }]]);
});

test('settlement that cannot be computed leaves the game counting', async () => {
  const w = world();
  const id = await startGame(w, P);
  await join(w, id, [P, S]);
  await handleUpdate(press(w.uid(), `${id}:end`, P), w.ctx);
  await stack(w, id, '1000', P);
  await stack(w, id, '2000', S);
  // a corrupt row makes the money computation throw (division by zero)
  await w.db.prepare('UPDATE games SET chips_per_buyin = 0 WHERE id = ?').bind(id).run();
  await assert.rejects(handleUpdate(press(w.uid(), `${id}:split`, P), w.ctx), RangeError);
  assert.equal((await loadGame(w.db, id)).status, 'counting');
});

test('a stack above 1e9 chips is not accepted', async () => {
  const w = world();
  const id = await startGame(w, P);
  await join(w, id, [P, S]);
  await handleUpdate(press(w.uid(), `${id}:end`, P), w.ctx);
  w.api.calls.length = 0;
  await stack(w, id, '1000000001', P);
  await stack(w, id, 'Саша 99999999999', P);
  assert.deepEqual(
    of(w.api, 'sendMessage').map((m) => m.text),
    ['Не понял. Число фишек, или «Имя число»', 'Не понял. Число фишек, или «Имя число»'],
  );
  assert.equal((await loadGame(w.db, id)).stacks.length, 0);
});

const D = { id: 5, first_name: 'Дима' };
const D2 = { id: 6, first_name: 'дима' };
const SA = { id: 7, first_name: 'Саша' };

test('Telegram user named like a guest gets a numbered name; both stacks enterable', async () => {
  const w = world();
  const id = await startGame(w, P);
  await join(w, id, [P]);
  await guest(w, id, 'Дима', P);
  await join(w, id, [D]);
  let g = await loadGame(w.db, id);
  assert.deepEqual(g.players.map((p) => p.name), ['Паша', 'Дима', 'Дима 2']);
  await handleUpdate(press(w.uid(), `${id}:end`, P), w.ctx);
  await stack(w, id, '2200', P);
  await stack(w, id, 'Дима 500', P);
  await stack(w, id, 'Дима 2 300', P);
  g = await loadGame(w.db, id);
  assert.equal(g.status, 'settled');
});

test('a second collision gets the next free number', async () => {
  const w = world();
  const id = await startGame(w, P);
  await join(w, id, [P]);
  await guest(w, id, 'Дима', P);
  await join(w, id, [D, D2]);
  const g = await loadGame(w.db, id);
  assert.deepEqual(g.players.map((p) => p.name), ['Паша', 'Дима', 'Дима 2', 'дима 3']);
});

test('a long name is trimmed so the suffix fits', async () => {
  const w = world();
  const id = await startGame(w, P);
  const long = 'Ж'.repeat(32);
  await guest(w, id, long, P);
  await join(w, id, [{ id: 8, first_name: long }]);
  const g = await loadGame(w.db, id);
  assert.equal(g.players[1].name, `${'Ж'.repeat(30)} 2`);
  assert.equal(g.players[1].name.length, 32);
});

test('rejoin that now collides with a guest is renamed', async () => {
  const w = world();
  const id = await startGame(w, P);
  await join(w, id, [P, SA]);
  await handleUpdate(press(w.uid(), `${id}:undo`, SA), w.ctx);
  await guest(w, id, 'Саша', P);
  await join(w, id, [SA]);
  const g = await loadGame(w.db, id);
  assert.deepEqual(g.players.map((p) => p.name), ['Паша', 'Саша 2', 'Саша']);
  assert.equal(g.players[1].tgUserId, SA.id);
});
