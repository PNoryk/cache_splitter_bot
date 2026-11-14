/**
 * Minimal Telegram Bot API caller for deploy scripts; never puts the token in errors.
 */

/**
 * Calls one Telegram Bot API method.
 * @param {typeof fetch} fetchFn
 * @param {string} token
 * @param {string} method
 * @param {object} body
 * @returns {Promise<any>} the `result` field of the API response
 */
export async function call(fetchFn, token, method, body) {
  const res = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method} failed: ${data.description ?? res.status}`);
  return data.result;
}
