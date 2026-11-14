/**
 * Cloudflare Worker entry: Telegram webhook.
 */
import { createApi } from './telegram.js';
import { handleUpdate } from './handlers.js';

export default {
  /**
   * Webhook endpoint; always 200 after authentication so Telegram does not retry.
   * @param {Request} request
   * @param {{BOT_TOKEN: string, WEBHOOK_SECRET: string, BOT_USERNAME: string, DB: any}} env
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
    const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const update = await request.json();
      await handleUpdate(update, {
        db: env.DB, api: createApi(env.BOT_TOKEN), botUsername: env.BOT_USERNAME,
      });
    } catch (e) {
      console.error('update failed', e);
    }
    return new Response('ok');
  },
};
