/**
 * Message texts and inline keyboards (Russian UI, plain text, no parse_mode).
 * Every view returns {text, reply_markup?}.
 */
import { formatKop } from '../core/money.js';
import {
  bankChips,
  investedKop,
  buyinsOf,
  activeEntries,
  discrepancyChips,
} from '../core/game.js';

/**
 * @typedef {import('../core/types.js').GameSnapshot} GameSnapshot
 * @typedef {import('../core/types.js').Player} Player
 * @typedef {import('../core/types.js').Transfer} Transfer
 * @typedef {{text: string, callback_data?: string, url?: string}} Button
 * @typedef {{text: string, reply_markup?: {inline_keyboard: Button[][]}}} View
 */

/** Callback actions understood by the handlers. */
export const ACTIONS = Object.freeze({
  join: 'join',
  rebuy: 'rebuy',
  rb: 'rb',
  undo: 'undo',
  guest: 'guest',
  end: 'end',
  back: 'back',
  zero: 'zero',
  cancel: 'cancel',
  cancel_yes: 'cancel_yes',
  cancel_no: 'cancel_no',
  fix: 'fix',
  split: 'split',
  round: 'round',
  exact: 'exact',
});

const KNOWN_ACTIONS = new Set(Object.values(ACTIONS));
const RECENT_REBUYS = 5;

/**
 * Build callback_data.
 * @param {number} gameId
 * @param {string} action
 * @param {number | string} [arg]
 * @returns {string}
 */
export function cb(gameId, action, arg) {
  return arg === undefined ? `${gameId}:${action}` : `${gameId}:${action}:${arg}`;
}

/**
 * Parse callback_data; null if malformed or the action is unknown.
 * @param {string} data
 * @returns {{gameId: number, action: string, arg: string | null} | null}
 */
export function parseCb(data) {
  const m = /^(\d+):([a-z_]+)(?::(.+))?$/.exec(String(data));
  if (!m || !KNOWN_ACTIONS.has(m[2])) return null;
  return { gameId: Number(m[1]), action: m[2], arg: m[3] ?? null };
}

/**
 * Russian plural of "закуп".
 * @param {number} n
 * @returns {string}
 */
function buyinsWord(n) {
  const last2 = n % 100;
  const last = n % 10;
  if (last2 >= 11 && last2 <= 14) return `${n} закупов`;
  if (last === 1) return `${n} закуп`;
  if (last >= 2 && last <= 4) return `${n} закупа`;
  return `${n} закупов`;
}

/**
 * Name of the player with the given Telegram id, or "кто-то".
 * @param {GameSnapshot} g
 * @param {number} tgUserId
 * @returns {string}
 */
function nameByTg(g, tgUserId) {
  return g.players.find((p) => p.tgUserId === tgUserId)?.name ?? 'кто-то';
}

/**
 * Header line of a game.
 * @param {GameSnapshot} g
 * @returns {string}
 */
function header(g) {
  return `🃏 Игра · ${g.chipsPerBuyin} фишек = ${formatKop(g.priceKop)}`;
}

/**
 * Header, player lines, bank and recent third-party rebuys.
 * @param {GameSnapshot} g
 * @returns {string[]}
 */
function gameLines(g) {
  const lines = [header(g), ''];
  for (const p of g.players) {
    const mark = p.tgUserId === null ? '👤 ' : '';
    const money = formatKop(investedKop(g, p.id));
    lines.push(`${mark}${p.name} · ${buyinsWord(buyinsOf(g, p.id))} · ${money}`);
  }
  const bank = bankChips(g);
  lines.push('', `Банк: ${bank} фишек · ${formatKop((bank / g.chipsPerBuyin) * g.priceKop)}`);
  const recent = activeEntries(g)
    .filter((e) => {
      const owner = g.players.find((p) => p.id === e.playerId);
      return e.kind === 'rebuy' && owner && owner.tgUserId !== e.createdBy;
    })
    .slice(-RECENT_REBUYS);
  if (recent.length > 0) {
    lines.push('');
    for (const e of recent) {
      const owner = g.players.find((p) => p.id === e.playerId);
      lines.push(`${nameByTg(g, e.createdBy)} → докуп ${owner?.name}`);
    }
  }
  return lines;
}

/**
 * Main game message in the chat.
 * @param {GameSnapshot} g
 * @param {string} botUsername
 * @returns {View}
 */
export function gameView(g, botUsername) {
  const lines = gameLines(g);
  if (g.status === 'settled') return { text: [...lines, '', '✅ Рассчитана'].join('\n') };
  if (g.status === 'cancelled') return { text: [...lines, '', '❌ Игра отменена'].join('\n') };
  const text = lines.join('\n');
  if (g.status === 'counting') {
    return {
      text,
      reply_markup: {
        inline_keyboard: [[{ text: 'Вернуться в игру', callback_data: cb(g.id, ACTIONS.back) }]],
      },
    };
  }
  return {
    text,
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Я в игре', callback_data: cb(g.id, ACTIONS.join) },
          { text: '+ Докуп', callback_data: cb(g.id, ACTIONS.rebuy) },
        ],
        [
          { text: 'Добавить гостя', callback_data: cb(g.id, ACTIONS.guest) },
          { text: 'Пригласить ↗', url: `https://t.me/${botUsername}?start=join_${g.id}` },
        ],
        [
          { text: '↩ Отменить', callback_data: cb(g.id, ACTIONS.undo) },
          { text: 'Закончить', callback_data: cb(g.id, ACTIONS.end) },
        ],
        [{ text: 'Отменить игру', callback_data: cb(g.id, ACTIONS.cancel) }],
      ],
    },
  };
}

/**
 * Private-chat message of a player.
 * @param {GameSnapshot} g
 * @returns {View}
 */
export function personalView(g) {
  return {
    text: gameLines(g).join('\n'),
    reply_markup: {
      inline_keyboard: [
        [
          { text: '+ Докуп', callback_data: cb(g.id, ACTIONS.rebuy) },
          { text: '↩ Отменить', callback_data: cb(g.id, ACTIONS.undo) },
        ],
      ],
    },
  };
}

/**
 * Choose whom to rebuy for.
 * @param {GameSnapshot} g
 * @param {Player[]} targets
 * @returns {View}
 */
export function rebuyChooserView(g, targets) {
  const buttons = targets.map((p) => ({
    text: p.tgUserId === null ? `${p.name} 👤` : 'Себе',
    callback_data: cb(g.id, ACTIONS.rb, p.id),
  }));
  return {
    text: 'Кому докуп?',
    reply_markup: { inline_keyboard: buttons.map((b) => [b]) },
  };
}

/**
 * Stack counting message.
 * @param {GameSnapshot} g
 * @returns {View}
 */
export function countView(g) {
  const lines = [
    '🧮 Подсчёт',
    'Пришлите, сколько у вас фишек, одним числом.',
    'За гостя или другого игрока: имя и число, например «Дима 500».',
    '',
  ];
  for (const p of g.players) {
    const s = g.stacks.find((x) => x.playerId === p.id);
    if (!s) {
      lines.push(`${p.name}  —`);
    } else if (s.enteredBy === p.tgUserId) {
      lines.push(`${p.name}  ${s.chips} ✓`);
    } else {
      lines.push(`${p.name} ${s.chips} (ввёл ${nameByTg(g, s.enteredBy)})`);
    }
  }
  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'У меня 0', callback_data: cb(g.id, ACTIONS.zero) },
          { text: 'Вернуться в игру', callback_data: cb(g.id, ACTIONS.back) },
        ],
      ],
    },
  };
}

/**
 * Stacks do not match the bank.
 * @param {GameSnapshot} g
 * @returns {View}
 */
export function discrepancyView(g) {
  const d = discrepancyChips(g);
  const table = bankChips(g) + d;
  const money = formatKop(Math.round((d * g.priceKop) / g.chipsPerBuyin));
  const sign = d > 0 ? '+' : '';
  return {
    text:
      `⚠️ На столе ${table}, в банке ${bankChips(g)}` +
      ` — расхождение ${sign}${d} (${money})`,
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Дописать докуп', callback_data: cb(g.id, ACTIONS.fix) },
          { text: 'Разделить на всех', callback_data: cb(g.id, ACTIONS.split) },
        ],
      ],
    },
  };
}

/**
 * Final settlement.
 * @param {GameSnapshot} g
 * @param {{balances: number[], transfers: Transfer[]}} s
 * @param {{round: boolean, split: boolean}} opts
 * @returns {View}
 */
export function resultView(g, s, { round }) {
  const name = (/** @type {number} */ id) => g.players.find((p) => p.id === id)?.name ?? '?';
  const lines = ['✅ Итог', ''];
  if (s.transfers.length === 0) lines.push('Все при своих');
  for (const t of s.transfers) {
    lines.push(`${name(t.from)} → ${name(t.to)} ${formatKop(t.kop, { whole: round })}`);
  }
  const toggle = round
    ? { text: 'Точно', callback_data: cb(g.id, ACTIONS.exact) }
    : { text: 'Округлить', callback_data: cb(g.id, ACTIONS.round) };
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: [[toggle]] } };
}

/**
 * Confirm cancelling the game.
 * @param {GameSnapshot} g
 * @returns {View}
 */
export function cancelConfirmView(g) {
  return {
    text: 'Точно отменить игру?',
    reply_markup: {
      inline_keyboard: [
        [
          { text: 'Да', callback_data: cb(g.id, ACTIONS.cancel_yes) },
          { text: 'Нет', callback_data: cb(g.id, ACTIONS.cancel_no) },
        ],
      ],
    },
  };
}
