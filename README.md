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

- Set `TELEGRAM_BOT_TOKEN` in `.env` and restart: the bot starts long-polling and saves every text message (private chats only) to the sender's inbox. Duplicates are impossible: each `update_id` is processed at most once (`tg_updates`).
- BotFather setup (one-time, by the bot owner):
  1. `/newbot` → copy the token to `.env` (`TELEGRAM_BOT_TOKEN`).
  2. `/setcommands` → commands `start`, `help` (Russian descriptions optional).
  3. Mini App: `/newapp` (or `/setmenubutton`) → enter your **public HTTPS** origin. The same URL goes into `WEB_ORIGIN` — the "Open app" inline button links to it.
- The Mini App authenticates itself with the `x-telegram-init-data` header (HMAC, ±1 h). In production, a browser without valid `initData` gets `401` and the UI shows an expired-auth banner.

## API

- `GET /api/health` — public
- `GET /api/entries` — list of the owner's entries
- `POST /api/entries` `{text}` (1–10000 chars) — synchronous commit first, async classification after
- `PATCH /api/entries/:id` `{title?, kind?, project?, status?, tags?}` — `404` for other owners' ids
- `DELETE /api/entries/:id`
- `GET /api/entries/export` — one-click JSON backup of the owner's entries
- `GET /api/backup` — WAL-safe single-file SQLite snapshot of the live DB (`VACUUM INTO`), auth-protected

Auth: `x-telegram-init-data` header, HMAC-validated server-side (±1 h freshness, `timingSafeEqual`); entries scoped to the Telegram user id. In dev (`NODE_ENV != production`, `DEV_AUTH_BYPASS=true`) requests fall back to owner `local-dev`. Rate limit: 120 req/min per IP+path (`429`). Body limit 64 KB.

## Classification (optional, fail-open)

- Default: deterministic rule-based classifier (prefixes `Идея:/Задача:/…`, Russian/English keyword sets, `#tags`). This is not AI and works offline.
- Optional: set `GEMINI_API_KEY` to use Gemini behind the same interface (10 s timeout, 1 retry on 429/5xx).
- Fail-open: the entry is already committed before classification; on provider failure it keeps `ai_state=pending` and the original text is never modified.
- Classifier-picked projects are restricted to `PROJECT_ALLOWLIST` ∪ the owner's existing projects ∪ `Inbox`; manual project edits in the UI are user-controlled.

## Data & ops

- SQLite file at `DB_PATH` (default `./data/ideaflow.db`), WAL mode, versioned migrations (`schema_migrations`).
- Graceful shutdown on SIGINT/SIGTERM: bot polling stopped, HTTP server closed, DB closed.
- Single bot-polling instance per deployment (webhook + secret for scale).
- DB backup: use the JSON export endpoint, `GET /api/backup` (`VACUUM INTO`, safe on a live WAL database), or `node apps/api/backup.mjs backup|restore` for off-server copies. Never copy the raw `.db` file while the server is running.

## Tests

`npm test` (root) — 13 tests in 4 files: 10 integration tests that spawn the real server on random ports (401 without auth, dev-bypass hard-disabled in production, CRUD, initData CRUD, owner isolation, forged/expired/empty initData, input validation, deterministic classifier (kinds/allowlist/tags/no data loss), JSON export, rate limiting, data persistence after a hard kill + restart), 1 Telegram bot test (real grammY bot against a mocked Bot API: private save, update dedup via `tg_updates`, group rejection), 1 AI worker test (crash recovery, backoff, max attempts, optimistic concurrency), 1 backup test (WAL-safe `VACUUM INTO` snapshot + CLI restore + integrity check).

## Verified / not verified

- Verified (13/13 tests green, `npm test`): build, auth (HMAC initData, isolation, forged/expired/empty rejection, dev-bypass hard-disabled in production), CRUD, validation, rate limiting, JSON export, deterministic classifier (kinds/allowlist/tags, no data loss, prompt classification after POST), persistence after hard kill + restart, UTF-8 roundtrip, UI served at `/`, WAL-safe backup endpoint (`VACUUM INTO`) + CLI restore + `integrity_check`, Telegram bot path against a mocked Bot API (private save, update dedup via `tg_updates`, group rejection, `/start`), AI worker (crash recovery, backoff, max attempts, optimistic concurrency).
- Verified live (real Telegram bot token, 2026-11-16): bot connected and processed a real private message — entry saved with correct owner, classified by the deterministic fallback, `tg_updates` dedup row recorded, bot ack delivered, no server errors; entry survived a hard kill + restart (SQLite persistence live-confirmed).
- NOT verified: Mini App behind public HTTPS (requires the user's VPS/reverse proxy); live Telegram redelivery dedup (redelivery is covered by the mocked bot test); graceful-shutdown handlers cannot be triggered via `child_process` on Windows (crash persistence is covered by the SIGKILL test).

## Critical caveats

- Never expose a dev-bypass server to the internet; `DEV_AUTH_BYPASS` is hard-disabled in production.
- Docker (`compose.yaml`) binds to localhost:3000 — put HTTPS at a reverse proxy, never publish the port directly.
- Avoid sensitive personal or work content in free-tier external AI without explicit consent.
- Secrets: bot token and GEMINI key live only in `.env` (never committed); logs redact all request headers.

See `docs/IMPLEMENTATION_PLAN.md` and `docs/AGENT_PROMPT.md`.
