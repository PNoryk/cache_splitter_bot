import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMoney,
  formatKop,
  roundToTotal,
  splitEvenly,
  roundWhole,
} from '../core/money.js';

test('parseMoney accepts valid amounts', () => {
  assert.equal(parseMoney('50'), 5000);
  assert.equal(parseMoney('50.5'), 5050);
  assert.equal(parseMoney('50,25'), 5025);
});

test('parseMoney rejects invalid amounts', () => {
  assert.equal(parseMoney('0'), null);
  assert.equal(parseMoney('-5'), null);
  assert.equal(parseMoney('1.234'), null);
  assert.equal(parseMoney('abc'), null);
});

test('formatKop', () => {
  assert.equal(formatKop(3425), '34,25');
  assert.equal(formatKop(5), '0,05');
  assert.equal(formatKop(5000), '50,00');
  assert.equal(formatKop(3425, { whole: true }), '34');
  assert.equal(formatKop(-3425), '-34,25');
});

test('roundToTotal', () => {
  assert.deepEqual(roundToTotal([1n, 1n, 1n], 3n), [1, 0, 0]);
  assert.deepEqual(roundToTotal([5n, 5n], 2n), [3, 2]);
  assert.deepEqual(roundToTotal([6850n, 13150n, 0n], 1n), [6850, 13150, 0]);
  assert.deepEqual(roundToTotal([333n * 5050n], 1000n), [1682]);
});

test('splitEvenly', () => {
  assert.deepEqual(splitEvenly(100, 3), [34, 33, 33]);
  assert.deepEqual(splitEvenly(-100, 3), [-34, -33, -33]);
  assert.deepEqual(splitEvenly(0, 4), [0, 0, 0, 0]);
});

test('roundWhole', () => {
  assert.deepEqual(roundWhole([3425, -1575, -1850]), [3500, -1600, -1900]);
});
