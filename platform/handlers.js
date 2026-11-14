/**
 * Telegram update handling: /game, joining, rebuys, undo, guests, stack counting, settlement.
 */
import {
  markUpdate, findOpenGame, createGame, setMessageId, loadGame, addPlayer, addEntry,
  cancelEntry, setStatus, cancelGame, setPrice, upsertStack, findGameByCountMessage, findCountingGameForDm,
} from './db.js';
import {
  gameView, personalView, rebuyChooserView, countView, cancelConfirmView, discrepancyView, resultView,
  parseCb, ACTIONS,
} from './views.js';
import { TelegramError } from './telegram.js';
import { formatKop } from '../core/money.js';
import {
  parseGameArgs, rebuyTargets, undoTarget, settlement, discrepancyChips, missingStacks,
  parseStackInput, resolvePlayer, playerByTg,
} from '../core/game.js';

/**
 * @typedef {import('../core/types.js').GameSnapshot} GameSnapshot
 * @typedef {{call: (method: string, params?: object) => Promise<any>}} Api
 * @typedef {{db: any, api: Api, botUsername: string}} Ctx
 * @typedef {{id: number, first_name?: string, last_name?: string, is_bot?: boolean}} TgUser
 * @typedef {{ctx: Ctx, cq: any, g: GameSnapshot, arg: string | null}} CbCall
 */

const MAX_NAME = 32;
const GUEST_PROMPT_PREFIX = 'Имя гостя для игры #';
const COUNTING_TEXT = 'Идёт подсчёт — сначала «Вернуться в игру»';
const ENDED_TEXT = 'Игра уже закончена';
const NOT_IN_GAME = 'Ты не в игре';
const PRICE_USAGE = 'Формат: /price 1000 50';
const STACK_USAGE = 'Не понял. Число фишек, или «Имя число»';
const GAME_HINT = 'Чтобы начать игру, напишите: /game 1000 50\n'
  + '(фишек в одном закупе и цена закупа)';
const START_HELP = 'Я считаю деньги за покерные игры.\n'
  + 'В группе напишите /game 1000 50: фишек в закупе и цена закупа.\n'
  + 'Присоединиться можно кнопкой в игровом сообщении или по ссылке-приглашению.';

/**
 * Display name of a Telegram user, at most 32 chars.
 * @param {TgUser} user
 * @returns {string}
 */
function displayName(user) {
  const full = `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim();
  return full.slice(0, MAX_NAME);
}

/**
 * Edit the game message to the fresh snapshot; if it vanished, send a new one.
 * @param {Ctx} ctx
 * @param {number} gameId
 * @param {{cancelledByName?: string}} [opts] passed to gameView
 * @returns {Promise<void>}
 */
export async function refreshGameMessage(ctx, gameId, opts = {}) {
  const g = await loadGame(ctx.db, gameId);
  if (!g) return;
  const view = gameView(g, ctx.botUsername, opts);
  try {
    await ctx.api.call('editMessageText', {
      chat_id: g.chatId, message_id: g.messageId, ...view,
    });
  } catch (e) {
    const desc = e && /** @type {any} */ (e).description;
    if (typeof desc !== 'string' || !desc.includes('message to edit not found')) throw e;
    const sent = await ctx.api.call('sendMessage', { chat_id: g.chatId, ...view });
    await setMessageId(ctx.db, gameId, 'message_id', sent.message_id);
  }
}

/**
 * Answer a callback query.
 * @param {Ctx} ctx
 * @param {any} cq
 * @param {string} [text]
 * @returns {Promise<void>}
 */
async function answer(ctx, cq, text) {
  /** @type {any} */
  const params = { callback_query_id: cq.id };
  if (text !== undefined) {
    params.text = text;
    params.show_alert = false;
  }
  await ctx.api.call('answerCallbackQuery', params);
}

/**
 * Join the user to the game; sends nothing, returns whether a player was created.
 * @param {Ctx} ctx
 * @param {number} gameId
 * @param {TgUser} from
 * @returns {Promise<boolean>}
 */
async function joinUser(ctx, gameId, from) {
  const res = await addPlayer(ctx.db, gameId, {
    tgUserId: from.id, name: displayName(from), addedBy: from.id,
  });
  return res.created;
}

/**
 * Handle /game in a group.
 * @param {Ctx} ctx
 * @param {any} msg
 * @param {string} args
 * @returns {Promise<void>}
 */
async function cmdGame(ctx, msg, args) {
  const chatId = msg.chat.id;
  if (msg.chat.type === 'private') return;
  const parsed = parseGameArgs(args);
  if (!parsed) {
    await ctx.api.call('sendMessage', { chat_id: chatId, text: GAME_HINT });
    return;
  }
  /**
   * Reply "already running" under the open game.
   * @returns {Promise<void>}
   */
  const already = async () => {
    const open = await findOpenGame(ctx.db, chatId);
    const g = open === null ? null : await loadGame(ctx.db, open);
    await ctx.api.call('sendMessage', {
      chat_id: chatId,
      text: 'Уже идёт игра',
      ...(g && g.messageId ? { reply_to_message_id: g.messageId } : {}),
    });
  };
  if ((await findOpenGame(ctx.db, chatId)) !== null) return already();
  let id;
  try {
    id = await createGame(ctx.db, { chatId, ...parsed, createdBy: msg.from.id });
  } catch (e) {
    if (!/UNIQUE constraint failed/i.test(String(e && /** @type {any} */ (e).message))) throw e;
    return already();
  }
  const g = /** @type {GameSnapshot} */ (await loadGame(ctx.db, id));
  const sent = await ctx.api.call('sendMessage', {
    chat_id: chatId, ...gameView(g, ctx.botUsername),
  });
  await setMessageId(ctx.db, id, 'message_id', sent.message_id);
}

/**
 * Handle /start [payload].
 * @param {Ctx} ctx
 * @param {any} msg
 * @param {string} args
 * @returns {Promise<void>}
 */
async function cmdStart(ctx, msg, args) {
  if (msg.chat.type !== 'private') return;
  const m = /^join_(\d+)$/.exec(args.trim());
  if (!m) {
    await ctx.api.call('sendMessage', { chat_id: msg.chat.id, text: START_HELP });
    return;
  }
  const gameId = Number(m[1]);
  const g0 = await loadGame(ctx.db, gameId);
  if (!g0 || g0.status !== 'active') {
    await ctx.api.call('sendMessage', { chat_id: msg.chat.id, text: ENDED_TEXT });
    return;
  }
  const created = await joinUser(ctx, gameId, msg.from);
  const g = /** @type {GameSnapshot} */ (await loadGame(ctx.db, gameId));
  await ctx.api.call('sendMessage', { chat_id: msg.chat.id, ...personalView(g) });
  if (created) await refreshGameMessage(ctx, gameId);
}

/**
 * Handle /price: change chips per buyin and the price of the open game.
 * @param {Ctx} ctx
 * @param {any} msg
 * @param {string} args
 * @returns {Promise<void>}
 */
async function cmdPrice(ctx, msg, args) {
  const chatId = msg.chat.id;
  if (msg.chat.type === 'private') return;
  /**
   * Send a plain text message to the chat.
   * @param {string} text
   * @returns {Promise<void>}
   */
  const say = async (text) => {
    await ctx.api.call('sendMessage', { chat_id: chatId, text });
  };
  const gameId = await findOpenGame(ctx.db, chatId);
  if (gameId === null) return say('Нет активной игры');
  const parsed = parseGameArgs(args);
  if (!parsed) return say(PRICE_USAGE);
  await setPrice(ctx.db, gameId, parsed.chipsPerBuyin, parsed.priceKop);
  await refreshGameMessage(ctx, gameId);
  const g = /** @type {GameSnapshot} */ (await loadGame(ctx.db, gameId));
  if (g.status === 'counting') await refreshCountMessage(ctx, g);
  await say(
    `${displayName(msg.from)} изменил: ${parsed.chipsPerBuyin} фишек`
    + ` = ${formatKop(parsed.priceKop)}`,
  );
}

/** @type {Record<string, (ctx: Ctx, msg: any, args: string) => Promise<void>>} */
const COMMANDS = { game: cmdGame, start: cmdStart, price: cmdPrice };

/**
 * Handle a reply to the "guest name" prompt; true if the message was one.
 * @param {Ctx} ctx
 * @param {any} msg
 * @returns {Promise<boolean>}
 */
async function guestReply(ctx, msg) {
  const r = msg.reply_to_message;
  if (!r || !r.from || !r.from.is_bot || typeof r.text !== 'string') return false;
  if (!r.text.startsWith(GUEST_PROMPT_PREFIX)) return false;
  const m = /#(\d+)/.exec(r.text);
  const name = String(msg.text ?? '').trim().slice(0, MAX_NAME);
  if (!m || !name) return true;
  const gameId = Number(m[1]);
  const g = await loadGame(ctx.db, gameId);
  if (!g || g.status !== 'active') return true;
  await addPlayer(ctx.db, gameId, { tgUserId: null, name, addedBy: msg.from.id });
  await refreshGameMessage(ctx, gameId);
  return true;
}

/**
 * Handle an incoming message.
 * @param {Ctx} ctx
 * @param {any} msg
 * @returns {Promise<void>}
 */
async function handleMessage(ctx, msg) {
  if (typeof msg.text !== 'string' || !msg.from) return;
  if (await guestReply(ctx, msg)) return;
  if (!msg.text.startsWith('/') && (await stackMessage(ctx, msg))) return;
  const m = /^\/(\w+)(?:@(\w+))?(?:\s+([\s\S]*))?$/.exec(msg.text);
  if (!m) return;
  if (m[2] && m[2].toLowerCase() !== ctx.botUsername.toLowerCase()) return;
  const handler = COMMANDS[m[1].toLowerCase()];
  if (handler) await handler(ctx, msg, m[3] ?? '');
}

/**
 * Callback: join the game.
 * @param {CbCall} c
 * @returns {Promise<void>}
 */
async function cbJoin({ ctx, cq, g }) {
  const created = await joinUser(ctx, g.id, cq.from);
  await answer(ctx, cq, created ? undefined : 'Ты уже в игре');
  if (created) await refreshGameMessage(ctx, g.id);
}

/**
 * Rebuy for self, or send the chooser; reconciles after a direct rebuy while counting.
 * @param {CbCall} c
 * @returns {Promise<void>}
 */
async function rebuyFlow({ ctx, cq, g }) {
  const targets = rebuyTargets(g, cq.from.id);
  if (targets.length === 0) return answer(ctx, cq, 'Сначала „Я в игре“');
  if (targets.length === 1 && targets[0].tgUserId === cq.from.id) {
    await addEntry(ctx.db, g.id, targets[0].id, 'rebuy', cq.from.id);
    await answer(ctx, cq);
    await afterRebuy(ctx, g.id);
    return;
  }
  await answer(ctx, cq);
  await ctx.api.call('sendMessage', {
    chat_id: cq.message.chat.id,
    reply_to_message_id: cq.message.message_id,
    ...rebuyChooserView(g, targets),
  });
}

/**
 * After a rebuy: refresh the game message and, while counting, reconcile again.
 * @param {Ctx} ctx
 * @param {number} gameId
 * @returns {Promise<void>}
 */
async function afterRebuy(ctx, gameId) {
  await refreshGameMessage(ctx, gameId);
  const g = await loadGame(ctx.db, gameId);
  if (g && g.status === 'counting') await reconcile(ctx, g);
}

/**
 * Callback: rebuy for the chosen player.
 * @param {CbCall} c
 * @returns {Promise<void>}
 */
async function cbRb({ ctx, cq, g, arg }) {
  const target = rebuyTargets(g, cq.from.id).find((p) => String(p.id) === arg);
  if (!target) return answer(ctx, cq, 'Нельзя докупить за этого игрока');
  // Deleting the chooser is the lock: a repeated press finds it already gone.
  try {
    await ctx.api.call('deleteMessage', {
      chat_id: cq.message.chat.id, message_id: cq.message.message_id,
    });
  } catch (e) {
    if (!(e instanceof TelegramError)) throw e;
    return answer(ctx, cq);
  }
  await addEntry(ctx.db, g.id, target.id, 'rebuy', cq.from.id);
  await answer(ctx, cq);
  await afterRebuy(ctx, g.id);
}

/**
 * Callback: cancel the user's latest entry.
 * @param {CbCall} c
 * @returns {Promise<void>}
 */
async function cbUndo({ ctx, cq, g }) {
  const entry = undoTarget(g, cq.from.id);
  if (!entry) return answer(ctx, cq, 'Нечего отменять');
  await cancelEntry(ctx.db, entry.id);
  await answer(ctx, cq);
  await refreshGameMessage(ctx, g.id);
}

/**
 * Callback: ask for a guest name with ForceReply.
 * @param {CbCall} c
 * @returns {Promise<void>}
 */
async function cbGuest({ ctx, cq, g }) {
  await answer(ctx, cq);
  await ctx.api.call('sendMessage', {
    chat_id: cq.message.chat.id,
    text: `${GUEST_PROMPT_PREFIX}${g.id}? Ответьте на это сообщение.`,
    reply_markup: { force_reply: true, input_field_placeholder: 'Имя гостя' },
  });
}

/**
 * Send the discrepancy warning, or settle at once when the stacks match the bank.
 * Does nothing while some stacks are missing.
 * @param {Ctx} ctx
 * @param {GameSnapshot} g fresh snapshot of a counting game
 * @returns {Promise<void>}
 */
async function reconcile(ctx, g) {
  if (missingStacks(g).length > 0) return;
  if (discrepancyChips(g) !== 0) {
    await ctx.api.call('sendMessage', { chat_id: g.chatId, ...discrepancyView(g) });
    return;
  }
  await settle(ctx, g, false);
}

/**
 * Move counting to settled and send the result; only the winner of the
 * status transition sends it.
 * @param {Ctx} ctx
 * @param {GameSnapshot} g
 * @param {boolean} split
 * @returns {Promise<boolean>} whether this call settled the game
 */
async function settle(ctx, g, split) {
  if (!(await setStatus(ctx.db, g.id, ['counting'], 'settled'))) return false;
  const view = resultView(g, settlement(g, { split, round: false }), { round: false, split });
  await ctx.api.call('sendMessage', { chat_id: g.chatId, ...view });
  await refreshGameMessage(ctx, g.id);
  return true;
}

/**
 * Edit the count message to the current stacks, ignoring "not modified".
 * @param {Ctx} ctx
 * @param {GameSnapshot} g
 * @returns {Promise<void>}
 */
async function refreshCountMessage(ctx, g) {
  if (g.countMessageId === null) return;
  try {
    await ctx.api.call('editMessageText', {
      chat_id: g.chatId, message_id: g.countMessageId, ...countView(g),
    });
  } catch (e) {
    const desc = e && /** @type {any} */ (e).description;
    if (typeof desc !== 'string' || !desc.includes('message is not modified')) throw e;
  }
}

/**
 * Record a stack for a player, refresh the count message and reconcile.
 * @param {Ctx} ctx
 * @param {number} gameId
 * @param {number} playerId
 * @param {number} chips
 * @param {number} enteredBy
 * @returns {Promise<void>}
 */
async function recordStack(ctx, gameId, playerId, chips, enteredBy) {
  await upsertStack(ctx.db, gameId, playerId, chips, enteredBy);
  const g = /** @type {GameSnapshot} */ (await loadGame(ctx.db, gameId));
  if (g.status !== 'counting') return;
  await refreshCountMessage(ctx, g);
  await reconcile(ctx, g);
}

/**
 * Handle a plain message as a stack entry; true if it was consumed.
 * @param {Ctx} ctx
 * @param {any} msg
 * @returns {Promise<boolean>}
 */
async function stackMessage(ctx, msg) {
  const chatId = msg.chat.id;
  let gameId = null;
  if (msg.chat.type === 'private') {
    gameId = await findCountingGameForDm(ctx.db, msg.from.id);
  } else if (msg.reply_to_message && msg.reply_to_message.message_id) {
    gameId = await findGameByCountMessage(ctx.db, chatId, msg.reply_to_message.message_id);
  }
  if (gameId === null) return false;
  const g = await loadGame(ctx.db, gameId);
  if (!g || g.status !== 'counting') return false;
  /**
   * Reply to the user's message.
   * @param {string} text
   * @returns {Promise<void>}
   */
  const reply = async (text) => {
    await ctx.api.call('sendMessage', {
      chat_id: chatId, reply_to_message_id: msg.message_id, text,
    });
  };
  const parsed = parseStackInput(msg.text);
  if (!parsed) return reply(STACK_USAGE).then(() => true);
  let player;
  if (parsed.name === null) {
    player = playerByTg(g, msg.from.id);
    if (!player) return reply(NOT_IN_GAME).then(() => true);
  } else {
    const found = resolvePlayer(g.players, parsed.name);
    if ('error' in found) {
      const text = found.error === 'not_found'
        ? `Нет игрока ${parsed.name}`
        : `Уточни имя: ${g.players
          .filter((p) => p.name.toLowerCase().startsWith(parsed.name.toLowerCase()))
          .map((p) => p.name)
          .join(', ')}`;
      return reply(text).then(() => true);
    }
    player = found.player;
  }
  await recordStack(ctx, g.id, player.id, parsed.chips, msg.from.id);
  return true;
}

/**
 * Callback: finish the game and start counting.
 * @param {CbCall} c
 * @returns {Promise<void>}
 */
async function cbEnd({ ctx, cq, g }) {
  if (!(await setStatus(ctx.db, g.id, ['active'], 'counting'))) return answer(ctx, cq);
  const sent = await ctx.api.call('sendMessage', { chat_id: g.chatId, ...countView(g) });
  await setMessageId(ctx.db, g.id, 'count_message_id', sent.message_id);
  await answer(ctx, cq);
  await refreshGameMessage(ctx, g.id);
}

/**
 * Callback: back from counting to the game.
 * @param {CbCall} c
 * @returns {Promise<void>}
 */
async function cbBack({ ctx, cq, g }) {
  if (!(await setStatus(ctx.db, g.id, ['counting'], 'active'))) return answer(ctx, cq);
  await answer(ctx, cq);
  await refreshGameMessage(ctx, g.id);
}

/**
 * Callback: own stack is zero.
 * @param {CbCall} c
 * @returns {Promise<void>}
 */
async function cbZero({ ctx, cq, g }) {
  const player = playerByTg(g, cq.from.id);
  if (!player) return answer(ctx, cq, NOT_IN_GAME);
  await answer(ctx, cq);
  await recordStack(ctx, g.id, player.id, 0, cq.from.id);
}

/**
 * Callback: split the discrepancy evenly and settle.
 * @param {CbCall} c
 * @returns {Promise<void>}
 */
async function cbSplit({ ctx, cq, g }) {
  await answer(ctx, cq);
  if (missingStacks(g).length > 0) return;
  await settle(ctx, g, true);
}

/**
 * Callback: round the result to whole units or show exact amounts.
 * @param {boolean} round
 * @returns {(c: CbCall) => Promise<void>}
 */
const cbRounding = (round) => async ({ ctx, cq, g }) => {
  await answer(ctx, cq);
  if (missingStacks(g).length > 0) return;
  const split = discrepancyChips(g) !== 0;
  const view = resultView(g, settlement(g, { split, round }), { round, split });
  await ctx.api.call('editMessageText', {
    chat_id: cq.message.chat.id, message_id: cq.message.message_id, ...view,
  });
};

/**
 * Callback: ask for confirmation before cancelling.
 * @param {CbCall} c
 * @returns {Promise<void>}
 */
async function cbCancel({ ctx, cq, g }) {
  await answer(ctx, cq);
  await ctx.api.call('sendMessage', {
    chat_id: cq.message.chat.id,
    reply_to_message_id: cq.message.message_id,
    ...cancelConfirmView(g),
  });
}

/**
 * Delete the pressed (confirmation) message, ignoring Telegram errors.
 * @param {Ctx} ctx
 * @param {any} cq
 * @returns {Promise<void>}
 */
async function deletePressed(ctx, cq) {
  try {
    await ctx.api.call('deleteMessage', {
      chat_id: cq.message.chat.id, message_id: cq.message.message_id,
    });
  } catch (e) {
    if (!(e instanceof TelegramError)) throw e;
  }
}

/**
 * Callback: confirmed cancel; only the first press cancels.
 * @param {CbCall} c
 * @returns {Promise<void>}
 */
async function cbCancelYes({ ctx, cq, g }) {
  if (!(await cancelGame(ctx.db, g.id, cq.from.id))) return answer(ctx, cq, ENDED_TEXT);
  await answer(ctx, cq);
  await deletePressed(ctx, cq);
  await refreshGameMessage(ctx, g.id, { cancelledByName: displayName(cq.from) });
}

/**
 * Callback: keep the game, drop the confirmation.
 * @param {CbCall} c
 * @returns {Promise<void>}
 */
async function cbCancelNo({ ctx, cq }) {
  await answer(ctx, cq);
  await deletePressed(ctx, cq);
}

/**
 * @typedef {{handler: (c: CbCall) => Promise<void>, statuses: string[]}} CbEntry
 */

/**
 * Callback actions with the game statuses they are allowed in. Later tasks
 * register their own entries (e.g. ['counting'], ['active', 'counting']).
 * @type {Record<string, CbEntry>}
 */
const CALLBACKS = {
  [ACTIONS.join]: { handler: cbJoin, statuses: ['active'] },
  [ACTIONS.rebuy]: { handler: rebuyFlow, statuses: ['active'] },
  [ACTIONS.rb]: { handler: cbRb, statuses: ['active', 'counting'] },
  [ACTIONS.undo]: { handler: cbUndo, statuses: ['active'] },
  [ACTIONS.guest]: { handler: cbGuest, statuses: ['active'] },
  [ACTIONS.end]: { handler: cbEnd, statuses: ['active'] },
  [ACTIONS.back]: { handler: cbBack, statuses: ['counting'] },
  [ACTIONS.zero]: { handler: cbZero, statuses: ['counting'] },
  [ACTIONS.fix]: { handler: rebuyFlow, statuses: ['counting'] },
  [ACTIONS.split]: { handler: cbSplit, statuses: ['counting'] },
  [ACTIONS.cancel]: { handler: cbCancel, statuses: ['active', 'counting'] },
  [ACTIONS.cancel_yes]: { handler: cbCancelYes, statuses: ['active', 'counting'] },
  [ACTIONS.cancel_no]: { handler: cbCancelNo, statuses: ['active', 'counting'] },
  [ACTIONS.round]: { handler: cbRounding(true), statuses: ['settled'] },
  [ACTIONS.exact]: { handler: cbRounding(false), statuses: ['settled'] },
};

/**
 * Route a callback query.
 * @param {Ctx} ctx
 * @param {any} cq
 * @returns {Promise<void>}
 */
async function handleCallback(ctx, cq) {
  const parsed = parseCb(cq.data);
  const entry = parsed && CALLBACKS[parsed.action];
  if (!parsed || !entry || !cq.message) return answer(ctx, cq);
  const g = await loadGame(ctx.db, parsed.gameId);
  if (!g) return answer(ctx, cq, ENDED_TEXT);
  if (!entry.statuses.includes(g.status)) {
    return answer(ctx, cq, g.status === 'counting' ? COUNTING_TEXT : ENDED_TEXT);
  }
  await entry.handler({ ctx, cq, g, arg: parsed.arg });
}

/**
 * Handle one Telegram update (idempotent by update_id).
 * @param {any} update
 * @param {Ctx} ctx
 * @returns {Promise<void>}
 */
export async function handleUpdate(update, ctx) {
  if (!(await markUpdate(ctx.db, update.update_id))) return;
  if (update.message) await handleMessage(ctx, update.message);
  else if (update.callback_query) await handleCallback(ctx, update.callback_query);
}
