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
  activePlayers,
  MAX_CHIPS,
  MAX_PRICE_KOP,
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
  const amb = resolvePlayer(mk(['Вася', 'Валера', 'Петя']), 'Ва');
  assert.equal(amb.error, 'ambiguous');
  assert.deepEqual(amb.candidates.map((p) => p.name), ['Вася', 'Валера']);
  assert.deepEqual(resolvePlayer(mk(['Вася']), 'Петя'), { error: 'not_found' });
  assert.equal(resolvePlayer(mk(['Саша', 'Сашок']), 'Саша').player.name, 'Саша');
});

test('rebuyTargets and playerByTg', () => {
  const g = makeGame({ players: ['A'] });
  assert.deepEqual(rebuyTargets(g, 100).map((p) => p.name), ['A']);
  g.players.push({ id: 2, tgUserId: null, name: 'Гость', addedBy: 100 });
  g.entries.push({ id: 9, playerId: 2, kind: 'buyin', createdBy: 100, cancelled: false });
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

test('resolvePlayer: unique exact match wins, duplicate exact names are ambiguous', () => {
  const mk = (names) => names.map((name, i) => ({ id: i, tgUserId: null, name, addedBy: 1 }));
  assert.equal(resolvePlayer(mk(['Дима', 'Димон']), ' дима ').player.name, 'Дима');
  const dup = resolvePlayer(mk(['Дима', 'дима', 'Димон']), 'Дима');
  assert.equal(dup.error, 'ambiguous');
  assert.deepEqual(dup.candidates.map((p) => p.id), [0, 1]);
});

test('input caps: stacks up to 1e9 chips, buyin up to 1e9 chips and 1e6 rub', () => {
  assert.equal(MAX_CHIPS, 1_000_000_000);
  assert.equal(MAX_PRICE_KOP, 100_000_000);
  assert.deepEqual(parseStackInput('1000000000'), { name: null, chips: 1_000_000_000 });
  assert.equal(parseStackInput('1000000001'), null);
  assert.equal(parseStackInput('Вася 99999999999'), null);
  assert.deepEqual(parseGameArgs('1000000000 1000000'), {
    chipsPerBuyin: 1_000_000_000, priceKop: 100_000_000,
  });
  assert.equal(parseGameArgs('1000000001 50'), null);
  assert.equal(parseGameArgs('1000 1000000,01'), null);
});

test('a player whose only buyin was undone is out of the game', () => {
  const g = makeGame({ players: ['A', 'B', 'C'], stacks: { A: 1500, B: 500 } });
  g.entries.find((e) => e.playerId === 3).cancelled = true;
  assert.deepEqual(activePlayers(g).map((p) => p.name), ['A', 'B']);
  assert.deepEqual(missingStacks(g), []);
  assert.equal(discrepancyChips(g), 0);
  const s = settlement(g, { split: false, round: false });
  assert.deepEqual(s.balances, [2500, -2500]);
  assert.deepEqual(s.transfers, [{ from: 2, to: 1, kop: 2500 }]);
  assert.deepEqual(balances(g, { split: true }), [2500, -2500]);
  assert.deepEqual(rebuyTargets(g, 102), []);
  assert.equal(playerByTg(g, 102), undefined);
  assert.equal(playerByTg(g, 100).name, 'A');
});

test('a stack left by a player who later went out is ignored', () => {
  const g = makeGame({ players: ['A', 'B', 'C'], stacks: { A: 1000, B: 1000, C: 700 } });
  g.entries.find((e) => e.playerId === 3).cancelled = true;
  assert.equal(discrepancyChips(g), 0);
  assert.deepEqual(settlement(g, { split: false, round: false }).transfers, []);
});
