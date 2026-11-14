/**
 * Sets the bot's command menu and descriptions: node scripts/set-commands.js
 * Reads BOT_TOKEN from the environment; never prints it.
 */
import { pathToFileURL } from 'node:url';
import { call } from './bot-api.js';

const USAGE = 'Usage: BOT_TOKEN=... node scripts/set-commands.js';

/** @typedef {{command: string, description: string}} BotCommand */

/** @type {BotCommand[]} */
export const PRIVATE_COMMANDS = [
  { command: 'start', description: 'Что умеет бот' },
  { command: 'help', description: 'Как вести игру' },
];

/** @type {BotCommand[]} */
export const GROUP_COMMANDS = [
  { command: 'game', description: 'Начать игру: /game 1000 50 — фишек и цена закупа' },
  { command: 'price', description: 'Изменить закуп: /price 1000 50' },
  { command: 'help', description: 'Как вести игру' },
];

const DESCRIPTION = 'Считаю деньги за покерный вечер: закупы и докупы одной кнопкой,'
  + ' сверка банка со стеками и минимум переводов в конце.\n\n'
  + 'Добавьте меня в группу и напишите /game 1000 50 — закуп 1000 фишек за 50.';

const SHORT_DESCRIPTION = 'Учёт докупов и расчёт покерного вечера минимумом переводов';

/**
 * Sets command menus for private and group chats and the bot descriptions.
 * @param {Record<string, string | undefined>} env
 * @param {typeof fetch} fetchFn
 * @returns {Promise<void>}
 */
export async function setCommands(env, fetchFn = fetch) {
  const token = env.BOT_TOKEN;
  if (!token) throw new Error(USAGE);
  await call(fetchFn, token, 'setMyCommands', {
    commands: PRIVATE_COMMANDS, scope: { type: 'all_private_chats' },
  });
  await call(fetchFn, token, 'setMyCommands', {
    commands: GROUP_COMMANDS, scope: { type: 'all_group_chats' },
  });
  await call(fetchFn, token, 'setMyDescription', { description: DESCRIPTION });
  await call(fetchFn, token, 'setMyShortDescription', { short_description: SHORT_DESCRIPTION });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await setCommands(process.env);
    console.log('Команды и описание бота обновлены');
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
