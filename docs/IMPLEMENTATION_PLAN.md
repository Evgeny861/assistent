# IdeaFlow: MVP in 1–2 days — implementation contract

## Product intent
A private Telegram-first personal memory for ideas, wishes, plans, tasks, purchases and notes. Capture in bot, browse/edit in Telegram Mini App and ordinary web browser later. No duplicate reminder system. Must never lose an entry when AI fails.

## Scope boundaries
### P0 already scaffolded (verify and fix)
- Bot text -> SQLite entry, acknowledgement only after DB commit.
- Web UI add/list/filter/search client-side/update kind and status/delete.
- Telegram initData HMAC validation, owner isolation.
- Docker Compose with SQLite persistent volume and HTTPS reverse-proxy expectation.

### P0 to complete before release
1. Run `npm install`, `npm run build`, `npm run dev`; resolve all compiler/runtime failures.
2. Implement proper migrations with Drizzle or documented SQLite versioned migrations; do not leave production schema upgrades implicit.
3. Build automated API integration tests: unauthorized=401, owner isolation, CRUD, validation, malformed initData, expired initData, forged hash.
4. Set up HTTPS reverse proxy, hostname, Telegram bot menu URL and real initData end-to-end test on phone and desktop.
5. Rate limiting, request size limits, structured error logging without tokens/content, backup/restore drill, graceful shutdown.
6. Implement simple deterministic classifier as temporary fallback (do not call it AI), and optional Gemini provider behind interface. Parse with Zod; on failure retain entry with ai_state=pending.
7. Ensure no accidental secret logging and keep DEV_AUTH_BYPASS disabled in production.
8. Confirm license/dependency inventory and pin lockfile; scan dependencies.
9. Export all entries to JSON, one-click user data backup, recoverability check.
10. Check UI responsiveness, empty/loading/error states, manual project and title edit, basic tag editing.

### P1 after launch
- Integrate existing JSON reminder system via adapter (first inspect its code and data contract, never write JSON directly from IdeaFlow).
- Scheduled gentle resurfacing: opt-in, quiet hours, cooldown, snooze, completed, not relevant; no notification spam.
- Voice -> ASR -> original transcript retained; no loss on failures.
- Duplicate suggestion and merge only after user confirmation.
- Provider failover (Gemini, optional other providers) with retries, circuit breaker, explicit quota/cost cap.
- FTS5 search, later optional semantic search. Attachments, image capture, links.

### P2 optional
- AI weekly digest, linked ideas, advanced kanban, collaborative spaces, browser login, reminders dashboard, MCP, external Jira/GitHub integration.

## Minimal data model
`entries`: id, owner_id, original_text, title, kind, project, status, tags, ai_state, timestamps. Keep original_text immutable unless explicit user edit; add separate normalized fields. Later: `projects`, `entry_events`, `reminder_links`, `ai_jobs`, `ai_provider_usage`. Add indices on owner+date, owner+kind, owner+status. Never let LLM freely create unlimited project names; use an allowlist or require confirmation.

## AI provider interface
`classify({text, existingProjects}) -> {title,kind,project,tags,confidence}`. Validate JSON with Zod. Default classification provider configurable. Timeout ~10s, max 1 retry per provider, backoff on 429/5xx, skip on invalid credentials. Store raw input first, classify asynchronously. Explicit user confirmation for creating reminders or external actions. Do not send confidential content to free-tier external APIs without user opt-in.

## Reminder integration
Do not replace existing reminder JSON store. Inspect reminder bot's API, schedule rules, timezone, idempotency, cancellation and owner mapping. Implement adapter `create/list/cancel` and store `external_reminder_id`. No false confirmation until downstream acknowledges. Retain existing bot as delivery owner.

## Acceptance scenarios
1. Send bot 'Хочу в кино с Таней' -> entry appears in Mini App for same Telegram user, kind wish after classification.
2. Send 'Идея: переключать WG endpoint' -> project SputnikVPN only if configured/matched, original text retained.
3. Send 'Напомни в пятницу' -> initially entry saved; reminder created only after verified integration and explicit date/time resolution.
4. Provider unavailable -> message saved, pending indicator, no silent loss.
5. User A cannot read/update/delete user B entries.
6. Forged/expired initData rejected; production dev bypass always off.
7. Restart Docker -> data persists; backup restore tested.
8. Browser outside Telegram is explicitly unauthorized until separate auth is implemented.

## Suggested 2-day sequence
Day 1 AM: install/build/fix, migrations, test DB. Day 1 PM: Telegram real-device E2E, auth, responsive UI. Day 2 AM: AI classification with graceful fallback, project/tag editing. Day 2 PM: security tests, backup/export, HTTPS deploy, acceptance smoke test. If time runs short, ship capture + browse without AI; NEVER ship unauthenticated API.

## Architectural guardrails
- Monorepo with two workspaces; one Fastify process serving built Vite UI and polling Telegram.
- SQLite WAL, no Redis, no queue service, no microservices, no vector DB.
- Bot token only server side; Telegram initData must be verified on server.
- Avoid premature abstraction, plugins, admin panel, multi-tenant sharing, complex workflow engine.
- Keep user-visible states honest: pending classification is not a completed classification; queued reminder is not delivered reminder.
