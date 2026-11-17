import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real grammY Bot + real handlers + real SQLite, but the Telegram API is mocked:
// the bot's ApiClient points at a local HTTP server instead of api.telegram.org.
const BOT_TOKEN = '123456:TEST-TOKEN-ONLY-FOR-BOT-E2E';

function makeUpdate(partial: Record<string, unknown>): Record<string, unknown> {
  return { update_id: 1, ...partial };
}

function privateText(updateId: number, userId: number, text: string): Record<string, unknown> {
  return makeUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false, first_name: 'User' },
      chat: { id: userId, type: 'private', first_name: 'User' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  });
}

function groupText(updateId: number, userId: number, text: string): Record<string, unknown> {
  return makeUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false, first_name: 'User' },
      chat: { id: 999999, type: 'group', title: 'Group' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  });
}

function commandUpdate(updateId: number, userId: number, command: string): Record<string, unknown> {
  // Real Telegram always sends a bot_command entity for command messages;
  // grammY's command filter requires it.
  return makeUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false, first_name: 'User' },
      chat: { id: userId, type: 'private', first_name: 'User' },
      date: Math.floor(Date.now() / 1000),
      text: '/' + command,
      entities: [{ type: 'bot_command', offset: 0, length: 1 + command.length }],
    },
  });
}

test('Telegram bot (mocked API): save, dedup, group rejection, /start', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ideaflow-bot-test-'));
  process.env.DB_PATH = join(dir, 'bot.db');
  process.env.GEMINI_API_KEY = ''; // deterministic classifier only
  const { db, closeDb } = await import('../src/db.js');
  const { startTelegramBot } = await import('../src/bot.js');

  // Mock Telegram API server.
  const queue: Record<string, unknown>[] = [];
  const sentMessages: string[] = [];
  const mock = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += String(d)));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const method = url.pathname.replace(/^\/bot[^/]+\//, '');
      const reply = (payload: unknown) => {
        const body = Buffer.from(JSON.stringify(payload));
        // Explicit Content-Length: the undici client must not have to guess
        // chunked framing (unreliable for local responses under load).
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
        res.end(body);
      };
      if (method === 'getMe') {
        reply({ ok: true, result: { id: 424242, is_bot: true, first_name: 'TestBot', username: 'testbot' } });
      } else if (method === 'getUpdates') {
        const updates = queue.splice(0);
        reply({ ok: true, result: updates });
      } else if (method === 'sendMessage') {
        try {
          const p = JSON.parse(body);
          sentMessages.push(p.text || '');
        } catch { /* ignore */ }
        reply({ ok: true, result: { message_id: 1000, chat: { id: 111, type: 'private' }, text: 'ok' } });
      } else {
        reply({ ok: true, result: {} });
      }
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
  const mockPort = (mock.address() as { port: number }).port;

  const noopLog = { info: () => {}, warn: () => {}, error: () => {} };
  const bot = startTelegramBot({ token: BOT_TOKEN, db, log: noopLog, apiBaseURL: `http://127.0.0.1:${mockPort}` });
  t.after(async () => {
    await bot.stop();
    await new Promise<void>((r) => mock.close(() => r()));
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  const countEntries = (owner: string) =>
    (db.prepare('SELECT COUNT(*) AS n FROM entries WHERE owner_id = ?').get(owner) as { n: number }).n;

  // 1) Plain private message is saved as an entry.
  queue.push(privateText(1, 111, 'Хочу сходить в кино'));
  const deadline = Date.now() + 10_000;
  while (countEntries('111') < 1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
  assert.equal(countEntries('111'), 1, 'entry must be saved from a private message');
  const saved = db.prepare('SELECT original_text, ai_state FROM entries WHERE owner_id = ?').get('111') as { original_text: string; ai_state: string };
  assert.equal(saved.original_text, 'Хочу сходить в кино');
  assert.ok(['pending', 'done'].includes(saved.ai_state));
  assert.ok(sentMessages.some((m) => m.includes('Сохранено')), 'bot must acknowledge the save');

  // 2) The SAME update redelivered (e.g. after a crash between save and ack) must not duplicate.
  queue.push(privateText(1, 111, 'Хочу сходить в кино'));
  const d2 = Date.now() + 4000;
  while (Date.now() < d2) await new Promise((r) => setTimeout(r, 100)); // let the bot process it
  assert.equal(countEntries('111'), 1, 'redelivered update must not create a duplicate entry');

  // 3) Group messages are ignored.
  queue.push(groupText(2, 111, 'кино в группе'));
  const d3 = Date.now() + 4000;
  while (Date.now() < d3) await new Promise((r) => setTimeout(r, 100));
  assert.equal(countEntries('111'), 1, 'group message must not create an entry');

  // 4) /start replies but creates no entry.
  const before = sentMessages.length;
  queue.push(commandUpdate(3, 111, 'start'));
  const d4 = Date.now() + 4000;
  while (sentMessages.length <= before && Date.now() < d4) await new Promise((r) => setTimeout(r, 100));
  assert.ok(sentMessages.length > before, '/start must produce a reply');
  assert.equal(countEntries('111'), 1, '/start must not create an entry');
});
