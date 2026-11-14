/** Max count of nonzero balances solved exactly (bitmask DP, O(2^n * n)). */
export const EXACT_LIMIT = 15;

/**
 * @typedef {{from: number, to: number, kop: number}} Transfer
 */

/**
 * Greedy settlement of a group: largest debtor pays largest creditor.
 * @param {number[]} idx indices into balances (nonzero, zero total)
 * @param {number[]} balances
 * @returns {Transfer[]}
 */
function greedy(idx, balances) {
  const debtors = [];
  const creditors = [];
  for (const i of idx) {
    if (balances[i] < 0) debtors.push({ i, v: -balances[i] });
    else if (balances[i] > 0) creditors.push({ i, v: balances[i] });
  }
  /** @type {Transfer[]} */
  const out = [];
  while (debtors.length > 0 && creditors.length > 0) {
    debtors.sort((a, b) => b.v - a.v);
    creditors.sort((a, b) => b.v - a.v);
    const d = debtors[0];
    const c = creditors[0];
    const kop = Math.min(d.v, c.v);
    out.push({ from: d.i, to: c.i, kop });
    d.v -= kop;
    c.v -= kop;
    if (d.v === 0) debtors.shift();
    if (c.v === 0) creditors.shift();
  }
  return out;
}

/**
 * Minimal-count transfers settling balances. Positive balance receives money.
 * Exact for up to EXACT_LIMIT nonzero balances, greedy beyond that.
 * @param {number[]} balances integer kopecks, must sum to zero
 * @returns {Transfer[]} transfers with indices into `balances`
 */
export function minTransfers(balances) {
  if (balances.reduce((s, b) => s + b, 0) !== 0) {
    throw new Error('balances must sum to zero');
  }
  const nz = [];
  balances.forEach((b, i) => {
    if (b !== 0) nz.push(i);
  });
  const n = nz.length;
  if (n === 0) return [];
  if (n > EXACT_LIMIT) return greedy(nz, balances);

  const size = 1 << n;
  const sum = new Int32Array(size);
  const dp = new Int8Array(size);
  for (let mask = 1; mask < size; mask++) {
    const low = 31 - Math.clz32(mask & -mask);
    sum[mask] = sum[mask & (mask - 1)] + balances[nz[low]];
    let best = 0;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) best = Math.max(best, dp[mask ^ (1 << i)]);
    }
    dp[mask] = best + (sum[mask] === 0 ? 1 : 0);
  }

  // Peel bits off the full mask along an optimal path; zero-sum masks on
  // the path are group boundaries.
  const zeroMasks = [];
  let mask = size - 1;
  while (mask !== 0) {
    const isZero = sum[mask] === 0;
    if (isZero) zeroMasks.push(mask);
    const target = dp[mask] - (isZero ? 1 : 0);
    let next = -1;
    for (let i = 0; i < n; i++) {
      if (mask & (1 << i) && dp[mask ^ (1 << i)] === target) {
        next = mask ^ (1 << i);
        break;
      }
    }
    mask = next;
  }

  /** @type {Transfer[]} */
  const out = [];
  zeroMasks.push(0);
  for (let k = 0; k + 1 < zeroMasks.length; k++) {
    const group = zeroMasks[k] ^ zeroMasks[k + 1];
    const idx = [];
    for (let i = 0; i < n; i++) {
      if (group & (1 << i)) idx.push(nz[i]);
    }
    out.push(...greedy(idx, balances));
  }
  return out;
}
