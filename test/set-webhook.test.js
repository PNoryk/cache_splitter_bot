import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setWebhook } from '../scripts/set-webhook.js';

const ENV = { BOT_TOKEN: 't0ken', WEBHOOK_SECRET: 's3cret' };

/**
 * Fake fetch recording calls.
 * @param {object[]} calls
 * @returns {typeof fetch}
 */
function fakeFetch(calls) {
  return async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { status: 200, json: async () => ({ ok: true, result: { url: 'https://w.example' } }) };
  };
}

test('setWebhook sends secret and allowed_updates, returns info', async () => {
  const calls = [];
  const info = await setWebhook(['https://w.example'], ENV, fakeFetch(calls));
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/setWebhook$/);
  assert.deepEqual(calls[0].body, {
    url: 'https://w.example',
    secret_token: 's3cret',
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  assert.match(calls[1].url, /\/getWebhookInfo$/);
  assert.equal(info.url, 'https://w.example');
});

test('setWebhook rejects missing url or env without calling network', async () => {
  const calls = [];
  await assert.rejects(setWebhook([], ENV, fakeFetch(calls)), /Usage/);
  await assert.rejects(setWebhook(['u'], {}, fakeFetch(calls)), /Usage/);
  assert.equal(calls.length, 0);
});
