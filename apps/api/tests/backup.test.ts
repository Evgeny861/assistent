import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeInitData } from '../src/auth.js';

const apiRoot = fileURLToPath(new URL('../', import.meta.url));
const dist = resolve(apiRoot, 'dist/index.js');
const backupScript = resolve(apiRoot, 'backup.mjs');
const BOT_TOKEN = '123456:TEST-TOKEN-ONLY-FOR-INITDATA-HMAC';
const USER = { id: 333, first_name: 'Carla' };
const init = () => makeInitData(USER, BOT_TOKEN);
const HDR = { 'x-telegram-init-data': init() };

let seq = 0;
async function startServer(dbFile: string): Promise<{ proc: ChildProcess; base: string; cleanup: () => Promise<void> }> {
  const port = 4500 + (seq += 1);
  const proc = spawn(process.execPath, [dist], {
    cwd: apiRoot,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      HOST: '127.0.0.1',
      DB_PATH: dbFile,
      // initData auth needs a bot token; the test token never reaches Telegram
      // (bot start fails on getMe and is caught, see src/index.ts).
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      DEV_AUTH_BYPASS: '',    // real initData auth, no bypass
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
  let exited = false;
  proc.on('exit', () => { exited = true; });
  const cleanup = async () => {
    proc.kill('SIGTERM');
    const wait = Date.now() + 5000;
    while (!exited && Date.now() < wait) await new Promise((r) => setTimeout(r, 100));
    if (!exited) proc.kill('SIGKILL');
    while (!exited) await new Promise((r) => setTimeout(r, 100));
  };
  return { proc, base, cleanup };
}

async function j(method: string, url: string, body: unknown = undefined, headers: Record<string, string> = {}) {
  const res = await fetch(url, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data: unknown = null;
  try { data = await res.json(); } catch { /* not json */ }
  return { status: res.status, data, res };
}

test('WAL-safe backup endpoint + restore via backup.mjs on a live DB', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ideaflow-backup-data-'));
  const dbFile = join(dir, 'live.db');
  const s = await startServer(dbFile);
  t.after(async () => { await s.cleanup(); rmSync(dir, { recursive: true, force: true }); });

  // Create data while the server (and its WAL-mode DB) is live.
  const a = await j('POST', s.base + '/api/entries', { text: 'бэкап-заметка 1' }, HDR);
  assert.equal(a.status, 200);
  const b = await j('POST', s.base + '/api/entries', { text: 'бэкап-заметка 2' }, HDR);
  assert.equal(b.status, 200);

  // Unauthenticated backup is rejected (data is not public).
  assert.equal((await j('GET', s.base + '/api/backup')).status, 401);

  // Authenticated backup returns a DB file. (Plain fetch: the `j()` helper
  // consumes the body via res.json(), which would make arrayBuffer() fail.)
  const bk = await fetch(s.base + '/api/backup', { headers: HDR });
  assert.equal(bk.status, 200);
  assert.equal(bk.headers.get('content-disposition')?.includes('attachment'), true);
  const bytes = Buffer.from(await bk.arrayBuffer());
  assert.ok(bytes.length > 0, 'backup must not be empty');
  // The SQLite header must be present (a real DB file, not JSON or an error page).
  // The magic is 16 bytes: "SQLite format 3" + NUL.
  assert.equal(bytes.subarray(0, 16).toString('utf8'), 'SQLite format 3\x00');

  const bakFile = join(dir, 'backup.db');
  const restoredFile = join(dir, 'restored.db');
  writeFileSync(bakFile, bytes);
  const cli = (args: string[]) => new Promise<number>((res2) => {
    const p = spawn(process.execPath, [backupScript, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout?.on('data', (d) => (out += String(d)));
    p.stderr?.on('data', (d) => (out += String(d)));
    p.on('exit', (code) => res2(code ?? 1));
    p.on('error', () => res2(1));
  });
  const restoreExit = await cli(['restore', bakFile, restoredFile]);
  assert.equal(restoreExit, 0, 'restore must succeed');
  assert.ok(existsSync(restoredFile));

  // The restored file must contain exactly the data that existed at backup time.
  const Database = (await import('better-sqlite3')).default;
  const rd = new Database(restoredFile, { readonly: true });
  const rows = rd.prepare('SELECT original_text FROM entries').all() as { original_text: string }[];
  const texts = rows.map((r) => r.original_text).sort();
  assert.deepEqual(texts, ['бэкап-заметка 1', 'бэкап-заметка 2']);
  const integrity = (rd.prepare('PRAGMA integrity_check').get() as { integrity_check: string }).integrity_check;
  assert.equal(integrity, 'ok');
  rd.close();

  // The live server must still be healthy and its data intact (backup is read-only).
  const list = await j('GET', s.base + '/api/entries', undefined, HDR);
  assert.equal(list.status, 200);
  assert.equal((list.data as unknown as { length: number }).length, 2);
});
