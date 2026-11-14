import { createD1 } from './d1.js';
import { createFakeApi } from './fake-api.js';
import { handleUpdate } from '../../platform/handlers.js';
import { findOpenGame } from '../../platform/db.js';

export const BOT = 'cash_bot';
export const GROUP = -100;

/**
 * Fresh test world.
 * @returns {{db: any, api: any, ctx: any, uid: () => number}}
 */
export function world() {
  const db = createD1();
  const api = createFakeApi(100);
  let n = 0;
  return { db, api, ctx: { db, api, botUsername: BOT }, uid: () => ++n };
}

/**
 * Message update (command or plain text).
 * @param {number} id
 * @param {string} text
 * @param {any} from
 * @param {number} chat
 * @returns {any}
 */
export function cmd(id, text, from, chat = GROUP) {
  return {
    update_id: id,
    message: {
      message_id: id, text, from, chat: { id: chat, type: chat > 0 ? 'private' : 'supergroup' },
    },
  };
}

/**
 * Callback press update.
 * @param {number} id
 * @param {string} data
 * @param {any} from
 * @param {number} chat
 * @param {number} messageId
 * @returns {object}
 */
export function press(id, data, from, chat = GROUP, messageId = 100) {
  return {
    update_id: id,
    callback_query: {
      id: `cq${id}`, data, from, message: { message_id: messageId, chat: { id: chat } },
    },
  };
}

/**
 * Calls of a method.
 * @param {any} api
 * @param {string} method
 * @returns {any[]}
 */
export const of = (api, method) => api.calls.filter((c) => c.method === method).map((c) => c.params);

/**
 * Start a game in GROUP by `starter` and return its id.
 * @param {ReturnType<typeof world>} w
 * @param {any} starter
 * @returns {Promise<number>}
 */
export async function startGame(w, starter) {
  await handleUpdate(cmd(w.uid(), '/game 1000 50', starter), w.ctx);
  return /** @type {number} */ (await findOpenGame(w.db, GROUP));
}
