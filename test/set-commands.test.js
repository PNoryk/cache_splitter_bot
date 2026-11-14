import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setCommands, PRIVATE_COMMANDS, GROUP_COMMANDS } from '../scripts/set-commands.js';

/**
 * Fake fetch recording calls.
 * @param {object[]} calls
 * @returns {typeof fetch}
 */
function fakeFetch(calls) {
  return async (url, init) => {
    calls.push({ method: url.split('/').at(-1), body: JSON.parse(init.body) });
    return { status: 200, json: async () => ({ ok: true, result: true }) };
  };
}

test('setCommands sets private and group menus and both descriptions', async () => {
  const calls = [];
  await setCommands({ BOT_TOKEN: 't0ken' }, fakeFetch(calls));
  assert.deepEqual(calls.map((c) => c.method), [
    'setMyCommands', 'setMyCommands', 'setMyDescription', 'setMyShortDescription',
  ]);
  assert.deepEqual(calls[0].body, {
    commands: PRIVATE_COMMANDS, scope: { type: 'all_private_chats' },
  });
  assert.deepEqual(calls[1].body, {
    commands: GROUP_COMMANDS, scope: { type: 'all_group_chats' },
  });
  assert.deepEqual(GROUP_COMMANDS.map((c) => c.command), ['game', 'price', 'help']);
  assert.deepEqual(PRIVATE_COMMANDS.map((c) => c.command), ['start', 'help']);
  assert.ok(calls[2].body.description.length <= 512);
  assert.ok(calls[3].body.short_description.length <= 120);
});

test('setCommands rejects missing token without calling network', async () => {
  const calls = [];
  await assert.rejects(setCommands({}, fakeFetch(calls)), /Usage/);
  assert.equal(calls.length, 0);
});
