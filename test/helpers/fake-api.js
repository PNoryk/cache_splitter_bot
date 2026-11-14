/**
 * Fake Telegram API for tests: records calls, hands out message ids.
 * @param {number} [firstMessageId]
 * @returns {{call: (method: string, params: object) => Promise<any>,
 *   calls: {method: string, params: any}[], nextMessageId: number}}
 */
export function createFakeApi(firstMessageId = 1) {
  const api = {
    /** @type {{method: string, params: any}[]} */
    calls: [],
    nextMessageId: firstMessageId,
    /**
     * @param {string} method
     * @param {object} params
     * @returns {Promise<any>}
     */
    async call(method, params) {
      api.calls.push({ method, params });
      if (method === 'sendMessage') return { message_id: api.nextMessageId++ };
      return true;
    },
  };
  return api;
}
