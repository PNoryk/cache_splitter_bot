import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApi, TelegramError } from '../platform/telegram.js';
import { createFakeApi } from './helpers/fake-api.js';

/**
 * Fetch stub returning a fixed JSON body and recording requests.
 * @param {object} body
 * @returns {{fetchImpl: typeof fetch, requests: {url: string, init: any}[]}}
 */
function stubFetch(body) {
  /** @type {{url: string, init: any}[]} */
  const requests = [];
  const fetchImpl = /** @type {typeof fetch} */ (
    async (url, init) => {
      requests.push({ url: String(url), init });
      return /** @type {Response} */ ({ json: async () => body });
    }
  );
  return { fetchImpl, requests };
}

test('call posts JSON to the bot method URL and returns result', async () => {
  const { fetchImpl, requests } = stubFetch({ ok: true, result: { message_id: 7 } });
  const api = createApi('TOKEN', fetchImpl);
  const res = await api.call('sendMessage', { chat_id: 1, text: 'hi' });
  assert.deepEqual(res, { message_id: 7 });
  assert.equal(requests[0].url, 'https://api.telegram.org/botTOKEN/sendMessage');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers['content-type'], 'application/json');
  assert.deepEqual(JSON.parse(requests[0].init.body), { chat_id: 1, text: 'hi' });
});

test('message is not modified resolves to null', async () => {
  const { fetchImpl } = stubFetch({
    ok: false,
    error_code: 400,
    description: 'Bad Request: message is not modified: specified new message content',
  });
  const api = createApi('T', fetchImpl);
  assert.equal(await api.call('editMessageText', {}), null);
});

test('other errors throw TelegramError with code and description', async () => {
  const { fetchImpl } = stubFetch({
    ok: false,
    error_code: 403,
    description: 'Forbidden: bot was blocked',
  });
  const api = createApi('T', fetchImpl);
  await assert.rejects(
    () => api.call('sendMessage', {}),
    (e) =>
      e instanceof TelegramError &&
      e.code === 403 &&
      e.description === 'Forbidden: bot was blocked' &&
      e.message === 'Forbidden: bot was blocked',
  );
});

test('fake api records calls and numbers sent messages', async () => {
  const api = createFakeApi(10);
  assert.deepEqual(await api.call('sendMessage', { text: 'a' }), { message_id: 10 });
  assert.deepEqual(await api.call('sendMessage', { text: 'b' }), { message_id: 11 });
  assert.equal(await api.call('answerCallbackQuery', {}), true);
  assert.equal(api.nextMessageId, 12);
  assert.deepEqual(
    api.calls.map((c) => c.method),
    ['sendMessage', 'sendMessage', 'answerCallbackQuery'],
  );
});
