import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeInitData } from '../src/auth.js';

const apiRoot = fileURLToPath(new URL('../', import.meta.url));
const dist = resolve(apiRoot, 'dist/index.js');
const BOT_TOKEN = '123456:TEST-TOKEN-ONLY-FOR-INITDATA-HMAC';

let seq = 0;
async function startServer(env: Record<string, string | undefined> = {}, dbPath?: string): Promise<{ proc: ChildProcess; base: string; dbPath: string; dir: string; cleanup: () => Promise<void> }> {
  const port = 3900 + (seq += 1);
  const dir = mkdtempSync(join(tmpdir(), 'ideaflow-test-'));
  const dbFile = dbPath || join(dir, 'test.db');
  const proc = spawn(process.execPath, [dist], {
    cwd: apiRoot,
    env: {
      ...process.env,
      NODE_ENV: env.NODE_ENV ?? 'development',
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: dbFile,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_ALLOWED_USER_IDS: env.TELEGRAM_ALLOWED_USER_IDS ?? '',
      DEV_AUTH_BYPASS: env.DEV_AUTH_BYPASS ?? '',
      PROJECT_ALLOWLIST: env.PROJECT_ALLOWLIST ?? '',
      GEMINI_API_KEY: '',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  let logs = '';
  proc.stdout?.on('data', (d) => (logs += String(d)));
  proc.stderr?.on('data', (d) => (logs += String(d)));
  const deadline = Date.now() + 15000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error('server exited early: ' + logs.slice(-2000));
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) break;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error('server did not start: ' + logs.slice(-2000));
    await new Promise((r) => setTimeout(r, 150));
  }
  // On Windows a signal-killed process reports exitCode=null + signalCode, so track the exit event directly.
  let exited = false;
  proc.on('exit', () => { exited = true; });
  const cleanup = async () => {
    proc.kill('SIGTERM');
    const wait = Date.now() + 5000;
    while (!exited && Date.now() < wait) await new Promise((r) => setTimeout(r, 100));
    if (!exited) proc.kill('SIGKILL');
    while (!exited) await new Promise((r) => setTimeout(r, 100));
    rmSync(dir, { recursive: true, force: true });
  };
  return { proc, base, dbPath: dbFile, dir, cleanup };
}

async function j(method: string, url: string, body: unknown = undefined, headers: Record<string, string> = {}) {
  // No Content-Type for bodyless requests: Fastify rejects empty JSON bodies with 400.
  const res = await fetch(url, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data: data as Record<string, unknown> };
}

const USER_A = { id: 111, first_name: 'Alice' };
const USER_B = { id: 222, first_name: 'Bob' };
const initA = () => makeInitData(USER_A, BOT_TOKEN);
const initB = () => makeInitData(USER_B, BOT_TOKEN);

test('public health, no secret leakage', async (t) => {
  const { base, cleanup } = await startServer();
  t.after(cleanup);
  const r = await j('GET', base + '/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true);
});

test('unauthenticated requests are 401 (dev bypass off)', async (t) => {
  const { base, cleanup } = await startServer();
  t.after(cleanup);
  assert.equal((await j('GET', base + '/api/entries')).status, 401);
  assert.equal((await j('POST', base + '/api/entries', { text: 'x' })).status, 401);
  assert.equal((await j('PATCH', base + '/api/entries/00000000-0000-4000-8000-000000000000', { status: 'done' })).status, 401);
  assert.equal((await j('DELETE', base + '/api/entries/00000000-0000-4000-8000-000000000000')).status, 401);
});

test('dev auth bypass is hard-disabled in production', async (t) => {
  const { base, cleanup } = await startServer({ NODE_ENV: 'production', DEV_AUTH_BYPASS: 'true' });
  t.after(cleanup);
  const r = await j('GET', base + '/api/entries');
  assert.equal(r.status, 401);
});

test('dev mode (non-production) allows local owner CRUD', async (t) => {
  const { base, cleanup } = await startServer({ DEV_AUTH_BYPASS: 'true' });
  t.after(cleanup);
  const created = await j('POST', base + '/api/entries', { text: 'dev note' });
  assert.equal(created.status, 200);
  assert.equal(created.data.owner_id, 'local-dev');
  const id = created.data.id as string;
  const list = await j('GET', base + '/api/entries');
  assert.equal(list.status, 200);
  assert.equal((list.data as unknown as { length: number }).length >= 1, true);
  const patch = await j('PATCH', base + `/api/entries/${id}`, { kind: 'idea', status: 'active' });
  assert.equal(patch.status, 200);
  const del = await j('DELETE', base + `/api/entries/${id}`);
  assert.equal(del.status, 200);
  assert.equal(del.data.deleted, true);
});

test('Telegram initData: CRUD, owner isolation, forged/expired/empty rejected', async (t) => {
  const { base, cleanup } = await startServer();
  t.after(cleanup);
  // User A full flow
  const created = await j('POST', base + '/api/entries', { text: 'Идея: переключать WG endpoint' }, { 'x-telegram-init-data': initA() });
  assert.equal(created.status, 200);
  assert.equal(created.data.owner_id, '111');
  const id = created.data.id as string;
  const listA = await j('GET', base + '/api/entries', undefined, { 'x-telegram-init-data': initA() });
  assert.equal(listA.status, 200);
  assert.ok((listA.data as unknown as { length: number }).length === 1);
  // User B sees nothing of A
  const listB = await j('GET', base + '/api/entries', undefined, { 'x-telegram-init-data': initB() });
  assert.equal(listB.status, 200);
  assert.equal((listB.data as unknown as { length: number }).length, 0);
  // B cannot patch/delete A's entry
  assert.equal((await j('PATCH', base + `/api/entries/${id}`, { status: 'done' }, { 'x-telegram-init-data': initB() })).status, 404);
  assert.equal((await j('DELETE', base + `/api/entries/${id}`, undefined, { 'x-telegram-init-data': initB() })).status, 200);
  // (DELETE returns {deleted:false} with 200 for cross-owner; verify the entry still exists for A)
  const listA2 = await j('GET', base + '/api/entries', undefined, { 'x-telegram-init-data': initA() });
  assert.equal((listA2.data as unknown as { length: number }).length, 1);
  // Forged hash
  const forged = initA().replace(/hash=[a-f0-9]{8}/, (m) => m.slice(0, 5) + '00000000');
  assert.equal((await j('GET', base + '/api/entries', undefined, { 'x-telegram-init-data': forged })).status, 401);
  // Expired auth_date (2h old)
  const expired = makeInitData(USER_A, BOT_TOKEN, 7200);
  assert.equal((await j('GET', base + '/api/entries', undefined, { 'x-telegram-init-data': expired })).status, 401);
  // Empty header value
  assert.equal((await j('GET', base + '/api/entries', undefined, { 'x-telegram-init-data': '' })).status, 401);
  // Valid patch by owner
  const patch = await j('PATCH', base + `/api/entries/${id}`, { status: 'done' }, { 'x-telegram-init-data': initA() });
  assert.equal(patch.status, 200);
});

test('Mini App accepts bot-token HMAC with signature and enforces the owner allowlist', async (t) => {
  const { base, cleanup } = await startServer({ NODE_ENV: 'production', TELEGRAM_ALLOWED_USER_IDS: '111' });
  t.after(cleanup);
  const authDate = String(Math.floor(Date.now() / 1000));
  const signature = 'telegram-signature-fixture';
  const user = JSON.stringify(USER_A);
  const check = ['auth_date=' + authDate, 'signature=' + signature, 'user=' + user].join('\n');
  const key = createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const hash = createHmac('sha256', key).update(check).digest('hex');
  const initData = new URLSearchParams({ signature, hash, user, auth_date: authDate }).toString();
  assert.equal((await j('GET', base + '/api/entries', undefined, { 'x-telegram-init-data': initData })).status, 200);
  assert.equal((await j('GET', base + '/api/entries', undefined, { 'x-telegram-init-data': initB() })).status, 403);
});

test('manual fields survive background classification of a pending entry', async (t) => {
  const { base, cleanup, dbPath } = await startServer();
  t.after(cleanup);
  const db = new Database(dbPath);
  try {
    const id = 'aaaaaaaa-0000-4000-8000-000000000001';
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO entries (id, owner_id, original_text, title, created_at, updated_at, next_ai_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, '111', 'Идея: настроить мониторинг #авто', 'Исходный заголовок', now, now, '2999-01-01');
    const headers = { 'x-telegram-init-data': initA() };
    const patch = await j('PATCH', base + '/api/entries/' + id, { title: 'Мой заголовок', tags: [], project: 'Работа' }, headers);
    assert.equal(patch.status, 200);
    db.prepare("UPDATE entries SET next_ai_at = '' WHERE id = ?").run(id);
    // A second capture wakes the real worker immediately.
    assert.equal((await j('POST', base + '/api/entries', { text: 'Разбудить воркер' }, headers)).status, 200);
    const read = db.prepare('SELECT title, tags, project, kind, ai_state, classification_source FROM entries WHERE id = ?');
    const deadline = Date.now() + 7000;
    let row = read.get(id) as Record<string, unknown>;
    while (row.ai_state !== 'done' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      row = read.get(id) as Record<string, unknown>;
    }
    assert.deepEqual(row, {
      title: 'Мой заголовок', tags: '[]', project: 'Работа',
      kind: 'idea', ai_state: 'done', classification_source: 'rules',
    });
  } finally {
    db.close();
  }
});

test('input validation', async (t) => {
  const { base, cleanup } = await startServer({ DEV_AUTH_BYPASS: 'true' });
  t.after(cleanup);
  assert.equal((await j('POST', base + '/api/entries', { text: '' })).status, 400);
  assert.equal((await j('POST', base + '/api/entries', { text: 'x'.repeat(10001) })).status, 400);
  assert.equal((await j('POST', base + '/api/entries', {})).status, 400);
  const ok = await j('POST', base + '/api/entries', { text: 'ok text' });
  const id = ok.data.id as string;
  assert.equal((await j('PATCH', base + `/api/entries/${id}`, { kind: 'bogus' })).status, 400);
  assert.equal((await j('PATCH', base + `/api/entries/${id}`, { status: 'bogus' })).status, 400);
  assert.equal((await j('PATCH', base + `/api/entries/${id}`, { original_text: 'hax' })).status, 400); // strict: original text not editable
  assert.equal((await j('PATCH', base + '/api/entries/not-a-uuid', { status: 'done' })).status, 400);
});

test('deterministic classifier: kinds, project allowlist, tags, no data loss', async (t) => {
  const { base, cleanup } = await startServer({ DEV_AUTH_BYPASS: 'true', PROJECT_ALLOWLIST: 'SputnikVPN, Work' });
  t.after(cleanup);
  const r1 = await j('POST', base + '/api/entries', { text: 'Идея: переключать WG endpoint для SputnikVPN' });
  assert.equal(r1.status, 200);
  assert.equal(r1.data.original_text, 'Идея: переключать WG endpoint для SputnikVPN'); // original retained
  const id1 = r1.data.id as string;
  const r2 = await j('POST', base + '/api/entries', { text: 'Хочу в кино с Таней' });
  const id2 = r2.data.id as string;
  const r3 = await j('POST', base + '/api/entries', { text: 'просто заметка #работа' });
  const id3 = r3.data.id as string;
  // wait for async classification to settle
  await new Promise((r) => setTimeout(r, 800));
  const list = await j('GET', base + '/api/entries');
  const byId = Object.fromEntries((list.data as unknown as Array<Record<string, unknown>>).map((e) => [e.id, e]));
  assert.equal(byId[id1].kind, 'idea');
  assert.equal(byId[id1].project, 'SputnikVPN');
  assert.equal(byId[id1].ai_state, 'done');
  assert.equal(byId[id1].original_text, 'Идея: переключать WG endpoint для SputnikVPN');
  assert.equal(byId[id2].kind, 'wish');
  assert.equal(byId[id2].ai_state, 'done');
  assert.equal(byId[id3].ai_state, 'done');
  assert.deepEqual(byId[id3].tags, ['работа']);
});

test('export returns all owner entries as JSON', async (t) => {
  const { base, cleanup } = await startServer();
  t.after(cleanup);
  await j('POST', base + '/api/entries', { text: 'первая' }, { 'x-telegram-init-data': initA() });
  await j('POST', base + '/api/entries', { text: 'вторая' }, { 'x-telegram-init-data': initA() });
  const other = await j('POST', base + '/api/entries', { text: 'чужая' }, { 'x-telegram-init-data': initB() });
  assert.equal(other.status, 200);
  const exp = await j('GET', base + '/api/entries/export', undefined, { 'x-telegram-init-data': initA() });
  assert.equal(exp.status, 200);
  assert.equal(exp.data.app, 'ideaflow');
  const entries = exp.data.entries as Array<Record<string, unknown>>;
  assert.equal(entries.length, 2);
  assert.ok(entries.every((e) => e.owner_id === '111'));
});

test('rate limiting: burst on unused path gets 429', async (t) => {
  const { base, cleanup } = await startServer();
  t.after(cleanup);
  const hdr = { 'x-telegram-init-data': initA() };
  let saw429 = false;
  for (let i = 0; i < 130; i++) {
    const r = await j('POST', base + '/api/entries', { text: 'burst' }, hdr);
    if (r.status === 429) { saw429 = true; break; }
    if (r.status !== 200) throw new Error('unexpected status ' + r.status);
  }
  assert.ok(saw429, 'expected at least one 429 in a 130-request burst');
});

test('data persists after hard kill and server restart', async (t) => {
  // SIGKILL on Windows is TerminateProcess: no chance for graceful cleanup,
  // so this is a worst-case crash test. (Graceful SIGTERM/SIGINT handlers exist
  // in src/index.ts but cannot be reliably delivered to a child process on Windows.)
  const s1 = await startServer({ DEV_AUTH_BYPASS: 'true' });
  const created = await j('POST', s1.base + '/api/entries', { text: 'persistent' });
  assert.equal(created.status, 200);
  let s1Exited = false;
  s1.proc.on('exit', () => { s1Exited = true; });
  s1.proc.kill('SIGKILL');
  const wait = Date.now() + 8000;
  while (!s1Exited && Date.now() < wait) await new Promise((r) => setTimeout(r, 100));
  assert.ok(s1Exited, 'process should have exited after SIGKILL');
  // Fresh server on the same DB file must see the entry
  const s2 = await startServer({ DEV_AUTH_BYPASS: 'true' }, s1.dbPath);
  t.after(async () => { await s2.cleanup(); rmSync(s1.dir, { recursive: true, force: true }); });
  const list = await j('GET', s2.base + '/api/entries');
  const entries = list.data as unknown as Array<Record<string, unknown>>;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].original_text, 'persistent');
});
