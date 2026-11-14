/**
 * Telegram update handling for the game phase: /game, joining, rebuys, undo, guests.
 */
import {
  markUpdate, findOpenGame, createGame, setMessageId, loadGame, addPlayer, addEntry,
  cancelEntry,
} from './db.js';
import { gameView, personalView, rebuyChooserView, parseCb, ACTIONS } from './views.js';
import { parseGameArgs, rebuyTargets, undoTarget } from '../core/game.js';

/**
 * @typedef {import('../core/types.js').GameSnapshot} GameSnapshot
 * @typedef {{call: (method: string, params?: object) => Promise<any>}} Api
 * @typedef {{db: any, api: Api, botUsername: string}} Ctx
 * @typedef {{id: number, first_name?: string, last_name?: string, is_bot?: boolean}} TgUser
 * @typedef {{ctx: Ctx, cq: any, g: GameSnapshot, arg: string | null}} CbCall
 */

const MAX_NAME = 32;
const GUEST_PROMPT_PREFIX = 'Имя гостя для игры #';
const ENDED_TEXT = 'Игра уже закончена';
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
 * @returns {Promise<void>}
 */
export async function refreshGameMessage(ctx, gameId) {
  const g = await loadGame(ctx.db, gameId);
  if (!g) return;
  const view = gameView(g, ctx.botUsername);
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
  } catch {
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
  await joinUser(ctx, gameId, msg.from);
  const g = /** @type {GameSnapshot} */ (await loadGame(ctx.db, gameId));
  await ctx.api.call('sendMessage', { chat_id: msg.chat.id, ...personalView(g) });
  await refreshGameMessage(ctx, gameId);
}

/** @type {Record<string, (ctx: Ctx, msg: any, args: string) => Promise<void>>} */
const COMMANDS = { game: cmdGame, start: cmdStart };

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
 * Callback: rebuy for self or choose whom for.
 * @param {CbCall} c
 * @returns {Promise<void>}
 */
async function cbRebuy({ ctx, cq, g }) {
  const targets = rebuyTargets(g, cq.from.id);
  if (targets.length === 0) return answer(ctx, cq, 'Сначала „Я в игре“');
  if (targets.length === 1 && targets[0].tgUserId === cq.from.id) {
    await addEntry(ctx.db, g.id, targets[0].id, 'rebuy', cq.from.id);
    await answer(ctx, cq);
    await refreshGameMessage(ctx, g.id);
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
 * Callback: rebuy for the chosen player.
 * @param {CbCall} c
 * @returns {Promise<void>}
 */
async function cbRb({ ctx, cq, g, arg }) {
  const target = rebuyTargets(g, cq.from.id).find((p) => String(p.id) === arg);
  if (!target) return answer(ctx, cq, 'Нельзя докупить за этого игрока');
  await addEntry(ctx.db, g.id, target.id, 'rebuy', cq.from.id);
  await answer(ctx, cq);
  await ctx.api.call('deleteMessage', {
    chat_id: cq.message.chat.id, message_id: cq.message.message_id,
  });
  await refreshGameMessage(ctx, g.id);
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
    reply_markup: { force_reply: true, selective: true },
  });
}

/**
 * Callback handlers by action; each requires an active game. Later tasks add
 * their own tables and merge them in the router.
 * @type {Record<string, (c: CbCall) => Promise<void>>}
 */
const ACTIVE_ACTIONS = {
  [ACTIONS.join]: cbJoin,
  [ACTIONS.rebuy]: cbRebuy,
  [ACTIONS.rb]: cbRb,
  [ACTIONS.undo]: cbUndo,
  [ACTIONS.guest]: cbGuest,
};

/**
 * Route a callback query.
 * @param {Ctx} ctx
 * @param {any} cq
 * @returns {Promise<void>}
 */
async function handleCallback(ctx, cq) {
  const parsed = parseCb(cq.data);
  const handler = parsed && ACTIVE_ACTIONS[parsed.action];
  if (!parsed || !handler || !cq.message) return answer(ctx, cq);
  const g = await loadGame(ctx.db, parsed.gameId);
  if (!g || g.status !== 'active') return answer(ctx, cq, ENDED_TEXT);
  await handler({ ctx, cq, g, arg: parsed.arg });
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
