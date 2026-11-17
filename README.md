# IdeaFlow — personal memory MVP

**Status: working P0 MVP.** Single Node process: Fastify API + Telegram bot (grammy, polling) + better-sqlite3 (WAL) + built React Mini App served from the same process. No extra services.

## Local quick start

1. Node.js 22+ (verified on Node 24).
2. `npm install` — if npm blocks native build scripts: `npm approve-scripts better-sqlite3 esbuild` (root `allowScripts` already approves the pinned versions).
3. `cp .env.example .env` (on Windows: `Copy-Item .env.example .env`)
4. `npm run build` (builds web, then api)
5. `npm start` → API + UI on `http://localhost:3000`.

Dev with hot reload: `npm run dev` (API on :3000, Vite on :5173; `DEV_AUTH_BYPASS=true` is allowed only when `NODE_ENV != production`).

## Telegram

- Set `TELEGRAM_BOT_TOKEN` in `.env` and restart to enable long polling in private chats. Recall proposes a draft or asks a question. Confirm with **✓ Сохранить** or the text «да», correct the draft with a follow-up, or say «пока не сохраняй» to cancel. An explicit «Запиши …» saves directly when the intent is clear. Only confirmed entries appear in the Mini App.
- BotFather setup (one-time, by the bot owner):
  1. `/newbot` → copy the token to `.env` (`TELEGRAM_BOT_TOKEN`).
  2. `/setcommands` → commands `start`, `help`, `reminders` (Russian descriptions optional).
  3. Mini App: `/newapp` (or `/setmenubutton`) → enter your **public HTTPS** origin. The same URL goes into `WEB_ORIGIN` — the "Open app" inline button links to it.
- The Mini App authenticates itself with the `x-telegram-init-data` header (HMAC, ±1 h). For a private deployment, set `TELEGRAM_ALLOWED_USER_IDS` to a comma-separated list of Telegram user IDs. The bot ignores other users, and their authenticated API requests get `403`.

## Напоминания в Telegram

Напиши «через 3 часа напомни купить билеты» или «напомни завтра в 19:30 купить билеты».
Если данных мало, бот спросит дату, время или что именно напомнить. Можно ответить «20:00»,
«лучше в пятницу» или «текст: забрать заказ». Бот покажет полные дату, время и часовой пояс.
Кнопка «✓ Подтвердить» (или ответ «да») ставит напоминание. Часовой пояс задаёт
`REMINDER_TIME_ZONE` (по умолчанию `Europe/Moscow`).

Команда `/reminders` показывает ближайшие напоминания и позволяет их отменить.
У доставленного сообщения есть кнопки «✓ Готово» и «Через 10 минут». В Mini App
дата и статус видны на карточке задачи. Выполнение, архивирование и удаление
карточки отменяют предстоящую отправку, если она ещё не началась.

Запланированное время и очередь хранятся в SQLite. После простоя бот отправит
просроченные активные напоминания. Временные ошибки Telegram повторяются с задержкой.
При обрыве между приёмом сообщения Telegram и записью результата в SQLite возможна
повторная доставка. Gemini для напоминаний не требуется.

## API

- `GET /api/health` — public
- `GET /api/entries` — list of the owner's entries
- `POST /api/entries` `{text}` (1–10000 chars) — synchronous commit first, async classification after
- `PATCH /api/entries/:id` `{title?, kind?, project?, status?, tags?}` — `404` for other owners' ids
- `DELETE /api/entries/:id`
- `GET /api/entries/export` — one-click JSON backup of the owner's entries

Auth: `x-telegram-init-data` header, HMAC-validated server-side (±1 h freshness, `timingSafeEqual`); entries scoped to the Telegram user id. In dev (`NODE_ENV != production`, `DEV_AUTH_BYPASS=true`) requests fall back to owner `local-dev`. Rate limit: 120 req/min per IP+path (`429`). Body limit 64 KB.

## Classification (optional, fail-open)

- Default: deterministic rule-based classifier (prefixes `Идея:/Задача:/…`, Russian/English keyword sets, `#tags`). This is not AI and works offline.
- Optional: set `GEMINI_API_KEY` and, if needed, `GEMINI_MODEL` (default `gemini-3.5-flash`). Requests have a 10 s timeout and one retry on 429/5xx.
- The entry is committed before classification. On provider failure, rules take over. The UI shows which classifier ran. The original text and fields edited by the user are preserved.
- Classifier-picked projects are restricted to `PROJECT_ALLOWLIST` ∪ the owner's existing projects ∪ `Inbox`; manual project edits in the UI are user-controlled.

## Data & ops

- SQLite file at `DB_PATH` (default `./data/ideaflow.db`), WAL mode, versioned migrations (`schema_migrations`).
- Graceful shutdown on SIGINT/SIGTERM: bot polling stopped, HTTP server closed, DB closed.
- Single bot-polling instance per deployment (webhook + secret for scale).
- Use the JSON export for your own records. For a complete database snapshot use `node apps/api/backup.mjs backup <source.db> <out.db>`, including via `docker compose exec ideaflow` for paths inside the container. The CLI uses `VACUUM INTO` on the live WAL database and can restore a snapshot to a fresh file.

## Tests

`npm test` (root) runs the API, mocked Telegram, AI worker and SQLite backup integration tests. The suite covers Telegram `initData` with `signature`, the owner allowlist, transaction rollback on failed Telegram capture, manual edits during classification, provider fallback, and WAL-safe CLI backup and restore.

## Verified / not verified

- Verified live (real Telegram bot token, 2026-11-16): bot connected and processed a real private message — entry saved with correct owner, classified by the deterministic fallback, `tg_updates` dedup row recorded, bot ack delivered, no server errors; entry survived a hard kill + restart (SQLite persistence live-confirmed).
- NOT verified: Mini App behind public HTTPS (requires the user's VPS/reverse proxy); live Telegram redelivery dedup (redelivery is covered by the mocked bot test); graceful-shutdown handlers cannot be triggered via `child_process` on Windows (crash persistence is covered by the SIGKILL test).

## Critical caveats

- Never expose a dev-bypass server to the internet; `DEV_AUTH_BYPASS` is hard-disabled in production.
- Docker (`compose.yaml`) binds to localhost:3000 — put HTTPS at a reverse proxy, never publish the port directly.
- Avoid sensitive personal or work content in free-tier external AI without explicit consent.
- Secrets: bot token and GEMINI key live only in `.env` (never committed); logs redact all request headers.

See `docs/IMPLEMENTATION_PLAN.md` and `docs/AGENT_PROMPT.md`.
