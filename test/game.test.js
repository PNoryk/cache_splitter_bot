import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseGameArgs,
  bankChips,
  buyinsOf,
  investedKop,
  missingStacks,
  discrepancyChips,
  balances,
  settlement,
  parseStackInput,
  resolvePlayer,
  rebuyTargets,
  playerByTg,
  undoTarget,
  activeEntries,
} from '../core/game.js';

/**
 * Build a snapshot. Each player gets one buyin; rebuys maps name -> count.
 * @param {{chips?:number, price?:number, players:string[], rebuys?:Object<string,number>,
 *   stacks?:Object<string,number>}} o
 * @returns {import('../core/types.js').GameSnapshot}
 */
function makeGame(o) {
  const players = o.players.map((name, i) => ({
    id: i + 1,
    tgUserId: 100 + i,
    name,
    addedBy: 100 + i,
  }));
  const entries = [];
  for (const p of players) {
    entries.push({
      id: entries.length + 1,
      playerId: p.id,
      kind: 'buyin',
      createdBy: p.tgUserId,
      cancelled: false,
    });
    for (let k = 0; k < (o.rebuys?.[p.name] ?? 0); k++) {
      entries.push({
        id: entries.length + 1,
        playerId: p.id,
        kind: 'rebuy',
        createdBy: p.tgUserId,
        cancelled: false,
      });
    }
  }
  const stacks = Object.entries(o.stacks ?? {}).map(([name, chips]) => ({
    playerId: players.find((p) => p.name === name).id,
    chips,
    enteredBy: 100,
  }));
  return {
    id: 1,
    chatId: 1,
    messageId: null,
    countMessageId: null,
    chipsPerBuyin: o.chips ?? 1000,
    priceKop: o.price ?? 5000,
    status: 'counting',
    createdBy: 100,
    players,
    entries,
    stacks,
  };
}

const sum = (xs) => xs.reduce((s, x) => s + x, 0);

test('parseGameArgs', () => {
  assert.deepEqual(parseGameArgs('1000 50'), { chipsPerBuyin: 1000, priceKop: 5000 });
  assert.deepEqual(parseGameArgs('1000 50,5'), { chipsPerBuyin: 1000, priceKop: 5050 });
  assert.equal(parseGameArgs('1000'), null);
  assert.equal(parseGameArgs('0 50'), null);
  assert.equal(parseGameArgs('10.5 50'), null);
});

test('bank, buyins, invested; cancelled entries ignored', () => {
  const g = makeGame({ players: ['A', 'B', 'C'], rebuys: { A: 1 } });
  assert.equal(bankChips(g), 4000);
  assert.equal(buyinsOf(g, 1), 2);
  assert.equal(investedKop(g, 1), 10000);
  g.entries.find((e) => e.kind === 'rebuy').cancelled = true;
  assert.equal(bankChips(g), 3000);
  assert.equal(activeEntries(g).length, 3);
});

test('balances without discrepancy', () => {
  const g = makeGame({
    players: ['Паша', 'Дима', 'Саша'],
    rebuys: { Паша: 1 },
    stacks: { Паша: 1370, Дима: 2630, Саша: 0 },
  });
  assert.deepEqual(balances(g, { split: false }), [-3150, 8150, -5000]);
});

test('odd rate sums to exactly zero with integers', () => {
  const g = makeGame({
    price: 5050,
    players: ['A', 'B'],
    rebuys: { A: 1 },
    stacks: { A: 1333, B: 1667 },
  });
  const b = balances(g, { split: false });
  assert.equal(sum(b), 0);
  assert.ok(b.every(Number.isInteger));
});

test('positive discrepancy', () => {
  const g = makeGame({
    players: ['A', 'B', 'C'],
    stacks: { A: 1000, B: 1000, C: 2000 },
  });
  assert.equal(discrepancyChips(g), 1000);
  assert.throws(() => balances(g, { split: false }), { message: 'discrepancy' });
  const b = balances(g, { split: true });
  assert.deepEqual(b, [-1667, -1667, 3334]);
  assert.equal(sum(b), 0);
});

test('negative discrepancy with split', () => {
  const g = makeGame({
    players: ['A', 'B', 'C'],
    stacks: { A: 1000, B: 1000, C: 0 },
  });
  assert.equal(discrepancyChips(g), -1000);
  const b = balances(g, { split: true });
  assert.deepEqual(b, [1667, 1667, -3334]);
  assert.equal(sum(b), 0);
});

test('round: multiples of 100, sum zero', () => {
  const g = makeGame({
    price: 5050,
    players: ['A', 'B', 'C'],
    stacks: { A: 777, B: 1111, C: 1112 },
  });
  const r = settlement(g, { split: false, round: true });
  assert.ok(r.balances.every((x) => x % 100 === 0));
  assert.equal(sum(r.balances), 0);
});

test('settlement maps transfers to player ids', () => {
  const g = makeGame({
    players: ['A', 'B'],
    stacks: { A: 0, B: 2000 },
  });
  g.players[0].id = 7;
  g.players[1].id = 9;
  g.stacks[0].playerId = 7;
  g.stacks[1].playerId = 9;
  g.entries.forEach((e) => {
    e.playerId = e.playerId === 1 ? 7 : 9;
  });
  const r = settlement(g, { split: false, round: false });
  assert.deepEqual(r.transfers, [{ from: 7, to: 9, kop: 5000 }]);
});

test('missing stacks', () => {
  const g = makeGame({ players: ['A', 'B'], stacks: { A: 1000 } });
  assert.deepEqual(
    missingStacks(g).map((p) => p.name),
    ['B'],
  );
  assert.throws(() => balances(g, { split: true }), { message: 'missing_stacks' });
  assert.throws(() => discrepancyChips(g), { message: 'missing_stacks' });
  assert.throws(() => settlement(g, { split: true, round: false }), {
    message: 'missing_stacks',
  });
});

test('parseStackInput', () => {
  assert.deepEqual(parseStackInput('1370'), { name: null, chips: 1370 });
  assert.deepEqual(parseStackInput('Вася 800'), { name: 'Вася', chips: 800 });
  assert.deepEqual(parseStackInput('Вася Пупкин 800'), { name: 'Вася Пупкин', chips: 800 });
  assert.deepEqual(parseStackInput('0'), { name: null, chips: 0 });
  assert.deepEqual(parseStackInput('1 370'), { name: '1', chips: 370 });
  assert.equal(parseStackInput('-5'), null);
  assert.equal(parseStackInput('1370.5'), null);
  assert.equal(parseStackInput('Вася'), null);
});

test('resolvePlayer', () => {
  const mk = (names) => names.map((name, i) => ({ id: i, tgUserId: null, name, addedBy: 1 }));
  assert.equal(resolvePlayer(mk(['Вася']), 'вася').player.name, 'Вася');
  assert.deepEqual(resolvePlayer(mk(['Вася', 'Валера']), 'Ва'), { error: 'ambiguous' });
  assert.deepEqual(resolvePlayer(mk(['Вася']), 'Петя'), { error: 'not_found' });
  assert.equal(resolvePlayer(mk(['Саша', 'Сашок']), 'Саша').player.name, 'Саша');
});

test('rebuyTargets and playerByTg', () => {
  const g = makeGame({ players: ['A'] });
  assert.deepEqual(rebuyTargets(g, 100).map((p) => p.name), ['A']);
  g.players.push({ id: 2, tgUserId: null, name: 'Гость', addedBy: 100 });
  assert.deepEqual(rebuyTargets(g, 100).map((p) => p.name), ['A', 'Гость']);
  assert.deepEqual(rebuyTargets(g, 555).map((p) => p.name), ['Гость']);
  assert.equal(playerByTg(g, 100).name, 'A');
  assert.equal(playerByTg(g, 555), undefined);
});

test('undoTarget', () => {
  const g = makeGame({ players: ['A', 'B'], rebuys: { A: 2 } });
  // entries: A buyin(1), A rebuy(2), A rebuy(3), B buyin(4)
  assert.equal(undoTarget(g, 100).id, 3);
  g.entries[2].cancelled = true;
  assert.equal(undoTarget(g, 100).id, 2);
  assert.equal(undoTarget(g, 101).id, 4);
  assert.equal(undoTarget(g, 999), null);
});
