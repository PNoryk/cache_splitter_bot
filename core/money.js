/**
 * Money helpers. All amounts are integer kopecks (number); intermediate
 * products are BigInt so no floats are involved in sums.
 */

/**
 * Parse a user-entered amount ("50", "50.5", "50,25") into kopecks.
 * @param {string} text
 * @returns {number | null} kopecks, or null if not a positive amount with <= 2 decimals
 */
export function parseMoney(text) {
  const m = /^(\d+)(?:[.,](\d{1,2}))?$/.exec(String(text).trim());
  if (!m) return null;
  const kop = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || 0);
  if (!Number.isSafeInteger(kop) || kop <= 0) return null;
  return kop;
}

/**
 * Format kopecks as "34,25" (or "34" with whole: true, fraction dropped).
 * @param {number} kop
 * @param {{ whole?: boolean }} [opts]
 * @returns {string}
 */
export function formatKop(kop, opts = {}) {
  const sign = kop < 0 ? '-' : '';
  const abs = Math.abs(kop);
  const rub = Math.floor(abs / 100);
  if (opts.whole) return `${sign}${rub}`;
  return `${sign}${rub},${String(abs % 100).padStart(2, '0')}`;
}

/**
 * Floor division for BigInt (denom > 0).
 * @param {bigint} a
 * @param {bigint} b
 * @returns {bigint}
 */
function floorDiv(a, b) {
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
}

/**
 * Convert each nums[i]/denom to integer kopecks so that the result sums to
 * round-half-up(sum(nums)/denom). Largest remainders method; ties go to the
 * smaller index.
 * @param {bigint[]} nums
 * @param {bigint} denom positive
 * @returns {number[]}
 */
export function roundToTotal(nums, denom) {
  const total = nums.reduce((s, x) => s + x, 0n);
  const target = floorDiv(2n * total + denom, 2n * denom);
  const floors = nums.map((x) => floorDiv(x, denom));
  const rems = nums.map((x, i) => x - floors[i] * denom);
  let need = target - floors.reduce((s, x) => s + x, 0n);
  const order = nums
    .map((_, i) => i)
    .sort((a, b) => (rems[a] === rems[b] ? a - b : rems[a] > rems[b] ? -1 : 1));
  const result = floors.map(Number);
  for (const i of order) {
    if (need <= 0n) break;
    result[i] += 1;
    need -= 1n;
  }
  return result;
}

/**
 * Split total kopecks into n shares; indivisible kopecks go to the first shares.
 * @param {number} total
 * @param {number} n
 * @returns {number[]}
 */
export function splitEvenly(total, n) {
  const base = Math.trunc(total / n) + 0; // + 0 normalizes -0
  const extra = Math.abs(total % n);
  const sign = Math.sign(total);
  return Array.from({ length: n }, (_, i) => base + (i < extra ? sign : 0));
}

/**
 * Round balances to whole units (multiples of 100, half away from zero), then
 * add the negated sum to the element with the max balance (ties: smaller index).
 * @param {number[]} balances
 * @returns {number[]}
 */
export function roundWhole(balances) {
  const rounded = balances.map(
    (b) => Math.sign(b) * Math.floor((Math.abs(b) + 50) / 100) * 100 + 0,
  );
  if (rounded.length === 0) return rounded;
  const diff = -rounded.reduce((s, x) => s + x, 0);
  let maxIdx = 0;
  for (let i = 1; i < balances.length; i++) {
    if (balances[i] > balances[maxIdx]) maxIdx = i;
  }
  rounded[maxIdx] += diff;
  return rounded;
}
