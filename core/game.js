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

/** Largest accepted chip count (stack or chips per buyin). */
export const MAX_CHIPS = 1_000_000_000;
/** Largest accepted buyin price, kopecks. */
export const MAX_PRICE_KOP = 100_000_000;

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
  if (!Number.isSafeInteger(chipsPerBuyin) || chipsPerBuyin <= 0 || chipsPerBuyin > MAX_CHIPS) {
    return null;
  }
  if (priceKop === null || priceKop > MAX_PRICE_KOP) return null;
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
 * Players still in the game: with at least one active entry. Undoing the
 * initial buyin takes a player out.
 * @param {GameSnapshot} g
 * @returns {Player[]}
 */
export function activePlayers(g) {
  const ids = new Set(activeEntries(g).map((e) => e.playerId));
  return g.players.filter((p) => ids.has(p.id));
}

/**
 * Players in the game without an entered stack.
 * @param {GameSnapshot} g
 * @returns {Player[]}
 */
export function missingStacks(g) {
  const have = new Set(g.stacks.map((s) => s.playerId));
  return activePlayers(g).filter((p) => !have.has(p.id));
}

/**
 * Chip stack of each player in the game, in activePlayers order. Throws if any is missing.
 * @param {GameSnapshot} g
 * @returns {number[]}
 */
function stackList(g) {
  if (missingStacks(g).length > 0) throw new Error('missing_stacks');
  return activePlayers(g).map((p) => g.stacks.find((s) => s.playerId === p.id).chips);
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
 * Money balances in kopecks per activePlayers(g) (positive = receives).
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
  const players = activePlayers(g);
  const invested = players.map((p) => investedKop(g, p.id));
  const sumOf = (/** @type {number[]} */ xs) => xs.reduce((s, x) => s + x, 0);
  const d = sumOf(value) - sumOf(invested);
  if (d !== 0 && !split) throw new Error('discrepancy');
  const share = splitEvenly(d, players.length);
  return value.map((v, i) => v - invested[i] - share[i]);
}

/**
 * Balances (per activePlayers(g)) plus minimal transfers; transfer from/to are player ids.
 * @param {GameSnapshot} g
 * @param {{split: boolean, round: boolean}} opts
 * @returns {{balances: number[], transfers: Transfer[]}}
 */
export function settlement(g, { split, round }) {
  const players = activePlayers(g);
  let b = balances(g, { split });
  if (round) b = roundWhole(b);
  const transfers = minTransfers(b).map((t) => ({
    from: players[t.from].id,
    to: players[t.to].id,
    kop: t.kop,
  }));
  return { balances: b, transfers };
}

/**
 * Parse a stack message: optional name followed by an integer in [0, MAX_CHIPS].
 * @param {string} text
 * @returns {{name: string | null, chips: number} | null}
 */
export function parseStackInput(text) {
  const m = /^(?:(.*\S)\s+)?(\d+)$/s.exec(String(text).trim());
  if (!m) return null;
  const chips = Number(m[2]);
  if (!Number.isSafeInteger(chips) || chips > MAX_CHIPS) return null;
  return { name: m[1] ?? null, chips };
}

/**
 * Normalized form of a player name for comparison: trimmed, lower case.
 * @param {string} name
 * @returns {string}
 */
export function nameKey(name) {
  return String(name).trim().toLowerCase();
}

/**
 * Find a player by name: a unique exact (case-insensitive) match wins, else a
 * unique prefix match. Ambiguity returns the matching candidates.
 * @param {Player[]} players
 * @param {string} name
 * @returns {{player: Player} | {error: 'not_found'}
 *   | {error: 'ambiguous', candidates: Player[]}}
 */
export function resolvePlayer(players, name) {
  const q = nameKey(name);
  const exact = players.filter((p) => nameKey(p.name) === q);
  if (exact.length === 1) return { player: exact[0] };
  if (exact.length > 1) return { error: 'ambiguous', candidates: exact };
  const pref = players.filter((p) => nameKey(p.name).startsWith(q));
  if (pref.length === 1) return { player: pref[0] };
  if (pref.length === 0) return { error: 'not_found' };
  return { error: 'ambiguous', candidates: pref };
}

/**
 * Player in the game linked to a Telegram user (out players are not found).
 * @param {GameSnapshot} g
 * @param {number} tgUserId
 * @returns {Player | undefined}
 */
export function playerByTg(g, tgUserId) {
  return activePlayers(g).find((p) => p.tgUserId === tgUserId);
}

/**
 * Who a user can rebuy for: themselves (if playing) plus guests in the game.
 * @param {GameSnapshot} g
 * @param {number} tgUserId
 * @returns {Player[]}
 */
export function rebuyTargets(g, tgUserId) {
  return activePlayers(g).filter((p) => p.tgUserId === tgUserId || p.tgUserId === null);
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
