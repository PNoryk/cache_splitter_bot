/**
 * Thin Telegram Bot API client on top of fetch.
 */

/** Telegram API error with the API's error_code and description. */
export class TelegramError extends Error {
  /**
   * @param {string} description
   * @param {number} [code]
   */
  constructor(description, code) {
    super(description);
    this.name = 'TelegramError';
    this.description = description;
    this.code = code;
  }
}

/**
 * Create an API client.
 * @param {string} token bot token
 * @param {typeof fetch} [fetchImpl]
 * @returns {{call: (method: string, params?: object) => Promise<any>}}
 */
export function createApi(token, fetchImpl = fetch) {
  return {
    /**
     * Call a Bot API method. "message is not modified" yields null.
     * @param {string} method
     * @param {object} [params]
     * @returns {Promise<any>}
     */
    async call(method, params = {}) {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
      });
      const data = await res.json();
      if (data.ok) return data.result;
      const description = String(data.description ?? 'unknown error');
      if (description.includes('message is not modified')) return null;
      throw new TelegramError(description, data.error_code);
    },
  };
}
