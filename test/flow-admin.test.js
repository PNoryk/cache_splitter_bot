import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GROUP, world, cmd, press, of, startGame } from './helpers/updates.js';
import { handleUpdate } from '../platform/handlers.js';
import { loadGame, findOpenGame } from '../platform/db.js';

const A = { id: 1, first_name: 'Аня', last_name: 'Ким' };
const B = { id: 2, first_name: 'Боря' };

/**
 * Game by A with A and B joined; A rebought once (bank 3 buyins).
 * @param {ReturnType<typeof world>} w
 * @returns {Promise<number>}
 */
async function twoPlayers(w) {
  const id = await startGame(w, A);
  await handleUpdate(press(w.uid(), `${id}:join`, A), w.ctx);
  await handleUpdate(press(w.uid(), `${id}:join`, B), w.ctx);
  await handleUpdate(press(w.uid(), `${id}:rebuy`, A), w.ctx);
  return id;
}

/**
 * Last edit of the game message.
 * @param {ReturnType<typeof world>} w
 * @returns {string}
 */
const lastEdit = (w) => of(w.api, 'editMessageText').at(-1).text;

test('/price updates the game message and announces', async () => {
  const w = world();
  const id = await twoPlayers(w);
  assert.ok(lastEdit(w).includes('· 150,00'));
  w.api.calls.length = 0;
  await handleUpdate(cmd(w.uid(), '/price 1000 5', A), w.ctx);
  assert.ok(lastEdit(w).includes('· 15,00'));
  assert.ok(!lastEdit(w).includes('· 150,00'));
  const g = await loadGame(w.db, id);
  assert.equal(g.priceKop, 500);
  assert.equal(
    of(w.api, 'sendMessage').at(-1).text, 'Аня Ким изменил: 1000 фишек = 5,00',
  );
});

test('/price accepts a bot suffix, rejects a foreign one', async () => {
  const w = world();
  const id = await twoPlayers(w);
  await handleUpdate(cmd(w.uid(), '/price@other_bot 1000 5', A), w.ctx);
  assert.equal((await loadGame(w.db, id)).priceKop, 5000);
  await handleUpdate(cmd(w.uid(), '/price@cash_bot 1000 5', A), w.ctx);
  assert.equal((await loadGame(w.db, id)).priceKop, 500);
});

test('/price with no game or bad args', async () => {
  const w = world();
  await handleUpdate(cmd(w.uid(), '/price 1000 5', A), w.ctx);
  assert.equal(of(w.api, 'sendMessage').at(-1).text, 'Нет активной игры');
  const id = await startGame(w, A);
  await handleUpdate(cmd(w.uid(), '/price abc', A), w.ctx);
  assert.equal(of(w.api, 'sendMessage').at(-1).text, 'Формат: /price 1000 50');
  assert.equal((await loadGame(w.db, id)).priceKop, 5000);
});

test('/price while counting refreshes both messages and does not settle', async () => {
  const w = world();
  const id = await twoPlayers(w);
  await handleUpdate(press(w.uid(), `${id}:end`, A), w.ctx);
  const g0 = await loadGame(w.db, id);
  const m = cmd(w.uid(), 'Аня 2000', A);
  m.message.reply_to_message = { message_id: g0.countMessageId };
  await handleUpdate(m, w.ctx);
  w.api.calls.length = 0;
  await handleUpdate(cmd(w.uid(), '/price 1000 10', A), w.ctx);
  const targets = of(w.api, 'editMessageText').map((e) => e.message_id);
  assert.deepEqual(targets, [g0.messageId, g0.countMessageId]);
  assert.ok(lastEdit(w) !== undefined);
  const g = await loadGame(w.db, id);
  assert.equal(g.status, 'counting');
  assert.equal(g.priceKop, 1000);
});

test('cancel asks, cancel_yes cancels once and a new game can start', async () => {
  const w = world();
  const id = await twoPlayers(w);
  w.api.calls.length = 0;
  await handleUpdate(press(w.uid(), `${id}:cancel`, A), w.ctx);
  assert.equal(of(w.api, 'sendMessage')[0].text, 'Точно отменить игру?');
  await handleUpdate(press(w.uid(), `${id}:cancel_yes`, B, GROUP, 777), w.ctx);
  assert.deepEqual(of(w.api, 'deleteMessage'), [{ chat_id: GROUP, message_id: 777 }]);
  const g = await loadGame(w.db, id);
  assert.equal(g.status, 'cancelled');
  assert.equal(g.cancelledBy, B.id);
  assert.ok(lastEdit(w).endsWith('❌ Игра отменена (Боря)'));
  // second press loses
  w.api.calls.length = 0;
  await handleUpdate(press(w.uid(), `${id}:cancel_yes`, A, GROUP, 778), w.ctx);
  assert.equal(of(w.api, 'answerCallbackQuery')[0].text, 'Игра уже закончена');
  assert.equal(of(w.api, 'deleteMessage').length, 0);
  assert.equal((await loadGame(w.db, id)).cancelledBy, B.id);
  assert.equal(await findOpenGame(w.db, GROUP), null);
  await startGame(w, A);
  assert.notEqual(await findOpenGame(w.db, GROUP), null);
});

test('cancel_no keeps the game and deletes the confirmation', async () => {
  const w = world();
  const id = await twoPlayers(w);
  w.api.calls.length = 0;
  await handleUpdate(press(w.uid(), `${id}:cancel_no`, A, GROUP, 777), w.ctx);
  assert.deepEqual(of(w.api, 'deleteMessage'), [{ chat_id: GROUP, message_id: 777 }]);
  assert.equal((await loadGame(w.db, id)).status, 'active');
});

test('cancel works while counting', async () => {
  const w = world();
  const id = await twoPlayers(w);
  await handleUpdate(press(w.uid(), `${id}:end`, A), w.ctx);
  await handleUpdate(press(w.uid(), `${id}:cancel_yes`, A, GROUP, 777), w.ctx);
  assert.equal((await loadGame(w.db, id)).status, 'cancelled');
});
