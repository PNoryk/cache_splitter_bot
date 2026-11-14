import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXACT_LIMIT, minTransfers } from '../core/settle.js';

/**
 * Seeded deterministic PRNG (mulberry32).
 * @param {number} seed
 * @returns {() => number} function returning floats in [0, 1)
 */
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random set of n nonzero integer balances summing to zero.
 * @param {() => number} rng
 * @param {number} n
 * @returns {number[]}
 */
function randomBalances(rng, n) {
  for (;;) {
    const xs = [];
    let sum = 0;
    for (let i = 0; i < n - 1; i++) {
      let v = 0;
      while (v === 0) v = Math.floor(rng() * 21) - 10;
      xs.push(v);
      sum += v;
    }
    if (sum !== 0) {
      xs.push(-sum);
      return xs;
    }
  }
}

/**
 * Reference: minimal transfers = n - max number of zero-sum groups,
 * found by recursion over partitions.
 * @param {number[]} balances nonzero balances summing to zero
 * @returns {number}
 */
function bruteForceMin(balances) {
  /**
   * @param {number[]} rest
   * @returns {number} max zero-sum groups the rest can be split into
   */
  function maxGroups(rest) {
    if (rest.length === 0) return 0;
    const [first, ...others] = rest;
    let best = -Infinity;
    const m = others.length;
    for (let sub = 0; sub < 1 << m; sub++) {
      let sum = first;
      const remaining = [];
      for (let i = 0; i < m; i++) {
        if (sub & (1 << i)) sum += others[i];
        else remaining.push(others[i]);
      }
      if (sum === 0) best = Math.max(best, 1 + maxGroups(remaining));
    }
    return best;
  }
  return balances.length - maxGroups(balances);
}

/**
 * Apply transfers to balances and assert all become zero and kop > 0.
 * @param {number[]} balances
 * @param {{from: number, to: number, kop: number}[]} transfers
 * @returns {void}
 */
function assertSettles(balances, transfers) {
  const b = [...balances];
  for (const t of transfers) {
    assert.ok(Number.isInteger(t.kop) && t.kop > 0);
    b[t.from] += t.kop;
    b[t.to] -= t.kop;
  }
  assert.deepEqual(b, balances.map(() => 0));
}

test('empty and zero balances need no transfers', () => {
  assert.deepEqual(minTransfers([]), []);
  assert.deepEqual(minTransfers([0, 0]), []);
});

test('single pair', () => {
  assert.deepEqual(minTransfers([100, -100]), [{ from: 1, to: 0, kop: 100 }]);
});

test('known cases', () => {
  assert.equal(minTransfers([100, -100, 50, -50]).length, 2);
  assert.equal(minTransfers([500, 500, -300, -700, 1000, -1000]).length, 4);
  assert.equal(minTransfers([300, 200, -200, -300]).length, 2);
});

test('non-zero sum throws', () => {
  assert.throws(() => minTransfers([100, -50]));
});

test('property: settles and matches brute force minimum', () => {
  const rng = makeRng(12345);
  for (let iter = 0; iter < 200; iter++) {
    const n = 2 + Math.floor(rng() * 7);
    const balances = randomBalances(rng, n);
    const transfers = minTransfers(balances);
    assertSettles(balances, transfers);
    assert.equal(
      transfers.length,
      bruteForceMin(balances),
      `balances ${JSON.stringify(balances)}`,
    );
  }
});

test('indices refer to input array with zeros interleaved', () => {
  const balances = [0, 300, 0, -300];
  assert.deepEqual(minTransfers(balances), [{ from: 3, to: 1, kop: 300 }]);
});

test('20 nonzero balances use greedy fallback', () => {
  assert.ok(20 > EXACT_LIMIT);
  const rng = makeRng(777);
  const balances = randomBalances(rng, 20);
  const transfers = minTransfers(balances);
  assert.ok(transfers.length <= 19);
  assertSettles(balances, transfers);
});

test('15 nonzero balances are fast', () => {
  const rng = makeRng(99);
  const balances = randomBalances(rng, EXACT_LIMIT);
  const start = performance.now();
  const transfers = minTransfers(balances);
  const ms = performance.now() - start;
  console.log(`minTransfers(15) took ${ms.toFixed(2)} ms`);
  assertSettles(balances, transfers);
  assert.ok(ms < 50, `took ${ms} ms`);
});

test('subset sums beyond 32 bits stay exact', () => {
  const t = minTransfers([2147483648, 2147483648, -4294967296]);
  assert.equal(t.length, 2);
  assert.deepEqual(t.map((x) => x.kop).sort(), [2147483648, 2147483648]);
});
