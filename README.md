# Poker cash splitter bot

Telegram-бот для группового чата: считает, кто кому сколько должен после кеш-игры в покер.
Ведущий открывает игру, игроки вступают и докупаются кнопками, в конце вводятся стеки,
бот предлагает минимальный набор переводов. Cloudflare Workers + D1, без рантайм-зависимостей.

## Команды

- `/game <фишек> <цена>` — начать игру (фишек за один бай-ин и его цена).
- `/price <фишек> <цена>` — изменить курс фишек в текущей игре.

## Деплой

1. Создать бота в @BotFather, сохранить токен. Group Privacy оставить **включённой**
   (бот видит команды и ответы на свои сообщения, остальное ему не нужно).
2. `npx wrangler login`
3. `npx wrangler d1 create cash-splitter-bot` — `database_id` из вывода записать в `wrangler.toml`,
   там же в `BOT_USERNAME` указать username бота.
4. `npx wrangler d1 migrations apply DB --remote`
5. Секреты:
   ```
   openssl rand -hex 32          # значение для WEBHOOK_SECRET
   npx wrangler secret put BOT_TOKEN
   npx wrangler secret put WEBHOOK_SECRET
   ```
   Если воркер ещё не задеплоен, первый `wrangler secret put` предложит его создать — ответить
   «да» (или сначала выполнить шаг 6, затем вернуться к секретам).
6. `npm run deploy` — выведет URL воркера.
7. Зарегистрировать вебхук (токен и секрет не печатаются; `allowed_updates`: `message`,
   `callback_query`; `max_connections: 1` — апдейты обрабатываются по одному).
   Чтобы токен не попал в историю шелла, переменные берутся из `.dev.vars` (см. ниже):
   ```
   set -a; . ./.dev.vars; set +a; npm run set-webhook -- https://<worker>.workers.dev
   ```

## Локальная разработка

- `npm test`
- `cp .dev.vars.example .dev.vars`, заполнить `BOT_TOKEN` и `WEBHOOK_SECRET` (файл в `.gitignore`),
  затем `npx wrangler dev`.

## Чеклист ручной проверки (тестовый бот, тестовая группа)

- [ ] `/game 1000 50`
- [ ] два игрока нажимают «Я в игре», докуп, гость
- [ ] ссылка из лички, `↩`
- [ ] `Закончить`, ввод стеков
- [ ] расхождение: «Разделить на всех», «Округлить»
- [ ] CPU расчёта для 15 игроков в `npx wrangler tail`

## Переезд на Telegram Serverless

Меняется только `platform/` (воркер, клиент Telegram, доступ к БД). `core/` переносим как есть.
В схеме намеренно нет внешних ключей.
