/**
 * Registers the Telegram webhook: node scripts/set-webhook.js <worker-url>
 * Reads BOT_TOKEN and WEBHOOK_SECRET from the environment; never prints them.
 */
import { pathToFileURL } from 'node:url';

const USAGE = 'Usage: BOT_TOKEN=... WEBHOOK_SECRET=... node scripts/set-webhook.js <worker-url>';

/**
 * Calls one Telegram Bot API method.
 * @param {typeof fetch} fetchFn
 * @param {string} token
 * @param {string} method
 * @param {object} body
 * @returns {Promise<any>} the `result` field of the API response
 */
async function call(fetchFn, token, method, body) {
  const res = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method} failed: ${data.description ?? res.status}`);
  return data.result;
}

/**
 * Sets the webhook and returns getWebhookInfo.
 * @param {string[]} args CLI arguments (first is the worker URL)
 * @param {Record<string, string | undefined>} env
 * @param {typeof fetch} fetchFn
 * @returns {Promise<object>} webhook info
 */
export async function setWebhook(args, env, fetchFn = fetch) {
  const [url] = args;
  const { BOT_TOKEN: token, WEBHOOK_SECRET: secret } = env;
  if (!url || !token || !secret) throw new Error(USAGE);
  await call(fetchFn, token, 'setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  return call(fetchFn, token, 'getWebhookInfo', {});
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    console.log(JSON.stringify(await setWebhook(process.argv.slice(2), process.env), null, 2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
