import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './helpers/d1.js';
import {
  markUpdate, findOpenGame, createGame, setMessageId, loadGame,
  findGameByCountMessage, findCountingGameForDm, addPlayer, addEntry,
  cancelEntry, upsertStack, setStatus, setPrice,
} from '../platform/db.js';

const G = { chatId: -100, chipsPerBuyin: 1000, priceKop: 10000, createdBy: 1 };

test('create then load gives empty active snapshot', async () => {
  const db = createD1();
  const id = await createGame(db, G);
  assert.deepEqual(await loadGame(db, id), {
    id, chatId: -100, messageId: null, countMessageId: null, chipsPerBuyin: 1000,
    priceKop: 10000, status: 'active', createdBy: 1, players: [], entries: [], stacks: [],
  });
  assert.equal(await loadGame(db, 999), null);
  assert.equal(await findOpenGame(db, -100), id);
  assert.equal(await findOpenGame(db, -5), null);
});

test('one open game per chat', async () => {
  const db = createD1();
  const id = await createGame(db, G);
  await assert.rejects(createGame(db, G));
  assert.equal(await setStatus(db, id, ['active'], 'settled'), true);
  assert.equal(await findOpenGame(db, -100), null);
  assert.ok(await createGame(db, G));
});

test('addPlayer dedups by tgUserId and writes one buyin', async () => {
  const db = createD1();
  const id = await createGame(db, G);
  const a = await addPlayer(db, id, { tgUserId: 5, name: 'A', addedBy: 5 });
  const b = await addPlayer(db, id, { tgUserId: 5, name: 'A', addedBy: 5 });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.playerId, a.playerId);
  const g = await loadGame(db, id);
  assert.equal(g.players.length, 1);
  assert.deepEqual(g.entries.map((e) => e.kind), ['buyin']);
  assert.equal(g.entries[0].playerId, a.playerId);
  assert.equal(g.entries[0].cancelled, false);
});

test('guests with the same name are separate players', async () => {
  const db = createD1();
  const id = await createGame(db, G);
  const a = await addPlayer(db, id, { tgUserId: null, name: 'Vasya', addedBy: 1 });
  const b = await addPlayer(db, id, { tgUserId: null, name: 'Vasya', addedBy: 1 });
  assert.notEqual(a.playerId, b.playerId);
  assert.equal((await loadGame(db, id)).players.length, 2);
});

test('markUpdate is idempotent', async () => {
  const db = createD1();
  assert.equal(await markUpdate(db, 7), true);
  assert.equal(await markUpdate(db, 7), false);
});

test('setStatus is conditional', async () => {
  const db = createD1();
  const id = await createGame(db, G);
  assert.equal(await setStatus(db, id, ['active'], 'counting'), true);
  assert.equal(await setStatus(db, id, ['active'], 'counting'), false);
});

test('addEntry and cancelEntry', async () => {
  const db = createD1();
  const id = await createGame(db, G);
  const { playerId } = await addPlayer(db, id, { tgUserId: 5, name: 'A', addedBy: 5 });
  await addEntry(db, id, playerId, 'rebuy', 5);
  let g = await loadGame(db, id);
  assert.deepEqual(g.entries.map((e) => e.kind), ['buyin', 'rebuy']);
  await cancelEntry(db, g.entries[1].id);
  g = await loadGame(db, id);
  assert.deepEqual(g.entries.map((e) => e.cancelled), [false, true]);
});

test('upsertStack keeps one row with latest value', async () => {
  const db = createD1();
  const id = await createGame(db, G);
  const { playerId } = await addPlayer(db, id, { tgUserId: 5, name: 'A', addedBy: 5 });
  await upsertStack(db, id, playerId, 500, 5);
  await upsertStack(db, id, playerId, 700, 6);
  assert.deepEqual((await loadGame(db, id)).stacks, [{ playerId, chips: 700, enteredBy: 6 }]);
});

test('message ids, price, count lookups', async () => {
  const db = createD1();
  const id = await createGame(db, G);
  await setMessageId(db, id, 'message_id', 11);
  await setMessageId(db, id, 'count_message_id', 22);
  await setPrice(db, id, 500, 2500);
  const g = await loadGame(db, id);
  assert.equal(g.messageId, 11);
  assert.equal(g.countMessageId, 22);
  assert.equal(g.chipsPerBuyin, 500);
  assert.equal(g.priceKop, 2500);
  assert.equal(await findGameByCountMessage(db, -100, 22), id);
  assert.equal(await findGameByCountMessage(db, -100, 23), null);
  await addPlayer(db, id, { tgUserId: 5, name: 'A', addedBy: 5 });
  assert.equal(await findCountingGameForDm(db, 5), null);
  await setStatus(db, id, ['active'], 'counting');
  assert.equal(await findCountingGameForDm(db, 5), id);
  assert.equal(await findCountingGameForDm(db, 6), null);
});
