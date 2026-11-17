import './env.js';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { Bot } from 'grammy';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { db, listEntries, addEntry, closeDb } from './db.js';
import { isTelegramUserAllowed, resolveOwner } from './auth.js';
import { getClassifier, KINDS } from './classifier.js';
import { RateLimiter } from './rateLimit.js';
import { AiWorker } from './aiWorker.js';
import { startTelegramBot } from './bot.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
// Local-only bypass. Hard-disabled when NODE_ENV=production.
const devMode = process.env.DEV_AUTH_BYPASS === 'true' && process.env.NODE_ENV !== 'production';
const allowedOrigin = process.env.WEB_ORIGIN || 'http://localhost:5173';

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || (devMode ? 'info' : 'info'),
    // Never log Telegram initData (contains a user-scoped token) or other headers.
    redact: { paths: ['req.headers', 'req.headers.*'], censor: '[REDACTED]' },
  },
  bodyLimit: 64 * 1024,
});
await app.register(cors, { origin: allowedOrigin });

const limiter = new RateLimiter(60_000, 120); // 120 req/min per IP+path, 60s window
const sweeper = setInterval(() => limiter.sweep(), 300_000);

let bot: Bot | undefined;

// Recovery loop: re-classifies pending entries (immediately after startup, then every few seconds).
const aiWorker = new AiWorker(db);
aiWorker.start();

const entryPatchSchema = z.object({
  title: z.string().trim().min(1).max(180).optional(),
  kind: z.enum(KINDS).optional(),
  // Manual project edit: user-controlled, max 100 chars. Classifier projects are separately constrained.
  project: z.string().trim().min(1).max(100).optional(),
  status: z.enum(['inbox', 'active', 'done', 'archived']).optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(8).optional(),
}).strict();

// Basic security headers on every response.
// Fastify 5 onSend contract: the hook must either call the `next` callback
// (4th argument) or return a Promise — anything else leaves the response
// pipeline hanging.
app.addHook('onSend', (req, reply, payload, done) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'SAMEORIGIN');
  reply.header('Referrer-Policy', 'no-referrer');
  done(null, payload);
});

app.addHook('preHandler', async (req, reply) => {
  const path = req.url.split('?')[0];
  if (!path.startsWith('/api/') || path === '/api/health') return;
  if (!limiter.check(`${req.ip}|${path}`)) {
    reply.code(429).send({ error: 'Слишком много запросов, попробуйте позже' });
    return;
  }
  const owner = resolveOwner(req.headers, token, devMode);
  if (!owner) {
    reply.code(401).send({ error: 'Требуется аутентификация Telegram (Mini App)' });
    return;
  }
  if (owner !== 'local-dev' && !isTelegramUserAllowed(owner)) {
    reply.code(403).send({ error: 'У этого аккаунта нет доступа к Recall' });
    return;
  }
  (req as typeof req & { ownerId: string }).ownerId = owner;
});

app.get('/api/health', async () => ({ ok: true, ts: new Date().toISOString() }));

app.get('/api/entries', async (req) =>
  listEntries((req as typeof req & { ownerId: string }).ownerId).map((e) => ({ ...e, tags: JSON.parse(e.tags) })));

// One-click user data backup: all entries of the owner as JSON.
app.get('/api/entries/export', async (req) => {
  const owner = (req as typeof req & { ownerId: string }).ownerId;
  return { app: 'ideaflow', version: 1, exported_at: new Date().toISOString(), owner_id: owner, entries: listEntries(owner).map((e) => ({ ...e, tags: JSON.parse(e.tags) })) };
});

app.post('/api/entries', async (req, reply) => {
  const body = z.object({ text: z.string().trim().min(1).max(10000) }).safeParse(req.body);
  if (!body.success) return reply.code(400).send({ error: 'Некорректный текст' });
  const entry = addEntry((req as typeof req & { ownerId: string }).ownerId, body.data.text);
  // The entry is committed synchronously. Wake the AiWorker so the new entry
  // is classified promptly; the periodic tick covers crash recovery.
  aiWorker.kick();
  return entry;
});

app.patch('/api/entries/:id', async (req, reply) => {
  const params = z.object({ id: z.string().uuid() }).safeParse(req.params);
  const body = entryPatchSchema.safeParse(req.body);
  if (!params.success || !body.success) return reply.code(400).send({ error: 'Некорректные данные' });
  const owner = (req as typeof req & { ownerId: string }).ownerId;
  const old = db.prepare('SELECT id, tags FROM entries WHERE id = ? AND owner_id = ?').get(params.data.id, owner);
  if (!old) return reply.code(404).send({ error: 'Не найдено' });
  const fields = Object.entries(body.data);
  if (fields.length) {
    const sql = fields.map(([k]) => `${k} = ?`).join(', ');
    const values = fields.map(([k, v]) => (k === 'tags' ? JSON.stringify(v as string[]) : v));
    const manualFields = Object.fromEntries(fields.filter(([key]) => key !== 'status').map(([key]) => [key, true]));
    db.prepare(`UPDATE entries SET ${sql}, manual_fields = json_patch(manual_fields, ?), updated_at = ?
      WHERE id = ? AND owner_id = ?`)
      .run(...values, JSON.stringify(manualFields), new Date().toISOString(), params.data.id, owner);
  }
  return { ok: true };
});

app.delete('/api/entries/:id', async (req, reply) => {
  const id = z.string().uuid().safeParse((req.params as { id: string }).id);
  if (!id.success) return reply.code(400).send({ error: 'Некорректный id' });
  const result = db.prepare('DELETE FROM entries WHERE id = ? AND owner_id = ?').run(id.data, (req as typeof req & { ownerId: string }).ownerId);
  return { deleted: result.changes > 0 };
});

// Serve the built Mini App UI (apps/web/dist), with SPA fallback.
const webRoot = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot, prefix: '/' });
  app.setNotFoundHandler((req, reply) =>
    req.url.startsWith('/api/') ? reply.code(404).send({ error: 'Not found' }) : reply.sendFile('index.html'));
}

await app.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 3000) });
app.log.info(`IdeaFlow listening (classifier: ${getClassifier().name}, devBypass: ${devMode ? 'ON' : 'off'})`);

if (token) {
  bot = startTelegramBot({ token, db, log: app.log, webOrigin: process.env.WEB_ORIGIN });
} else {
  app.log.warn('TELEGRAM_BOT_TOKEN is not set — bot polling disabled');
}

app.log.info('AI worker started');

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal} received, shutting down`);
  clearInterval(sweeper);
  aiWorker.stop();
  try { bot?.stop(); } catch { /* not started */ }
  try { await app.close(); } catch { /* ignore */ }
  closeDb();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
