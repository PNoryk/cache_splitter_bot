/**
 * Pure poker game rules: bank, balances, settlement, input parsing.
 * Money is integer kopecks; products go through BigInt.
 */
import { parseMoney, roundToTotal, splitEvenly, roundWhole } from './money.js';
import { minTransfers } from './settle.js';

/**
 * @typedef {import('./types.js').GameSnapshot} GameSnapshot
 * @typedef {import('./types.js').Player} Player
 * @typedef {import('./types.js').Entry} Entry
 * @typedef {import('./types.js').Transfer} Transfer
 */

/**
 * Parse "/game" arguments: "<chips per buyin> <price>".
 * @param {string} args
 * @returns {{chipsPerBuyin: number, priceKop: number} | null}
 */
export function parseGameArgs(args) {
  const parts = String(args).trim().split(/\s+/);
  if (parts.length !== 2 || !/^\d+$/.test(parts[0])) return null;
  const chipsPerBuyin = Number(parts[0]);
  const priceKop = parseMoney(parts[1]);
  if (!Number.isSafeInteger(chipsPerBuyin) || chipsPerBuyin <= 0 || priceKop === null) {
    return null;
  }
  return { chipsPerBuyin, priceKop };
}

/**
 * Entries that are not cancelled.
 * @param {GameSnapshot} g
 * @returns {Entry[]}
 */
export function activeEntries(g) {
  return g.entries.filter((e) => !e.cancelled);
}

/**
 * Number of active buyins and rebuys of a player.
 * @param {GameSnapshot} g
 * @param {number} playerId
 * @returns {number}
 */
export function buyinsOf(g, playerId) {
  return activeEntries(g).filter((e) => e.playerId === playerId).length;
}

/**
 * Total chips in the bank.
 * @param {GameSnapshot} g
 * @returns {number}
 */
export function bankChips(g) {
  return activeEntries(g).length * g.chipsPerBuyin;
}

/**
 * Kopecks a player put in.
 * @param {GameSnapshot} g
 * @param {number} playerId
 * @returns {number}
 */
export function investedKop(g, playerId) {
  return buyinsOf(g, playerId) * g.priceKop;
}

/**
 * Players without an entered stack.
 * @param {GameSnapshot} g
 * @returns {Player[]}
 */
export function missingStacks(g) {
  const have = new Set(g.stacks.map((s) => s.playerId));
  return g.players.filter((p) => !have.has(p.id));
}

/**
 * Chip stack of each player, in g.players order. Throws if any is missing.
 * @param {GameSnapshot} g
 * @returns {number[]}
 */
function stackList(g) {
  if (missingStacks(g).length > 0) throw new Error('missing_stacks');
  return g.players.map((p) => g.stacks.find((s) => s.playerId === p.id).chips);
}

/**
 * Sum of stacks minus bank, in chips.
 * @param {GameSnapshot} g
 * @returns {number}
 */
export function discrepancyChips(g) {
  return stackList(g).reduce((s, x) => s + x, 0) - bankChips(g);
}

/**
 * Money balances in kopecks per g.players (positive = receives).
 * @param {GameSnapshot} g
 * @param {{split: boolean}} opts split the discrepancy evenly instead of throwing
 * @returns {number[]}
 */
export function balances(g, { split }) {
  const stacks = stackList(g);
  const value = roundToTotal(
    stacks.map((s) => BigInt(s) * BigInt(g.priceKop)),
    BigInt(g.chipsPerBuyin),
  );
  const invested = g.players.map((p) => investedKop(g, p.id));
  const sumOf = (/** @type {number[]} */ xs) => xs.reduce((s, x) => s + x, 0);
  const d = sumOf(value) - sumOf(invested);
  if (d !== 0 && !split) throw new Error('discrepancy');
  const share = splitEvenly(d, g.players.length);
  return value.map((v, i) => v - invested[i] - share[i]);
}

/**
 * Balances plus minimal transfers; transfer from/to are player ids.
 * @param {GameSnapshot} g
 * @param {{split: boolean, round: boolean}} opts
 * @returns {{balances: number[], transfers: Transfer[]}}
 */
export function settlement(g, { split, round }) {
  let b = balances(g, { split });
  if (round) b = roundWhole(b);
  const transfers = minTransfers(b).map((t) => ({
    from: g.players[t.from].id,
    to: g.players[t.to].id,
    kop: t.kop,
  }));
  return { balances: b, transfers };
}

/**
 * Parse a stack message: optional name followed by a non-negative integer.
 * @param {string} text
 * @returns {{name: string | null, chips: number} | null}
 */
export function parseStackInput(text) {
  const m = /^(?:(.*\S)\s+)?(\d+)$/s.exec(String(text).trim());
  if (!m) return null;
  const chips = Number(m[2]);
  if (!Number.isSafeInteger(chips)) return null;
  return { name: m[1] ?? null, chips };
}

/**
 * Find a player by name: exact (case-insensitive) first, then by prefix.
 * @param {Player[]} players
 * @param {string} name
 * @returns {{player: Player} | {error: 'not_found' | 'ambiguous'}}
 */
export function resolvePlayer(players, name) {
  const q = name.trim().toLowerCase();
  const exact = players.filter((p) => p.name.toLowerCase() === q);
  if (exact.length === 1) return { player: exact[0] };
  if (exact.length > 1) return { error: 'ambiguous' };
  const pref = players.filter((p) => p.name.toLowerCase().startsWith(q));
  if (pref.length === 1) return { player: pref[0] };
  return { error: pref.length === 0 ? 'not_found' : 'ambiguous' };
}

/**
 * Player linked to a Telegram user.
 * @param {GameSnapshot} g
 * @param {number} tgUserId
 * @returns {Player | undefined}
 */
export function playerByTg(g, tgUserId) {
  return g.players.find((p) => p.tgUserId === tgUserId);
}

/**
 * Who a user can rebuy for: themselves (if playing) plus all guests.
 * @param {GameSnapshot} g
 * @param {number} tgUserId
 * @returns {Player[]}
 */
export function rebuyTargets(g, tgUserId) {
  return g.players.filter((p) => p.tgUserId === tgUserId || p.tgUserId === null);
}

/**
 * The user's latest non-cancelled entry.
 * @param {GameSnapshot} g
 * @param {number} tgUserId
 * @returns {Entry | null}
 */
export function undoTarget(g, tgUserId) {
  const own = activeEntries(g).filter((e) => e.createdBy === tgUserId);
  return own.length > 0 ? own[own.length - 1] : null;
}
