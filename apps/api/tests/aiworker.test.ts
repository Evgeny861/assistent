import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// In-process worker tests on a real SQLite DB and a simulated Gemini response.
const NOW = () => new Date().toISOString();
const UUID1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const UUID2 = 'bbbbbbbb-0000-4000-8000-000000000002';
const UUID3 = 'cccccccc-0000-4000-8000-000000000003';
const UUID4 = 'dddddddd-0000-4000-8000-000000000004';
const UUID5 = 'eeeeeeee-0000-4000-8000-000000000005';

async function waitFor(cond: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  assert.ok(cond(), 'timeout waiting for condition');
}

test('AI worker: crash recovery, backoff without fast retries, max attempts, concurrency guards', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ideaflow-ai-test-'));
  process.env.DB_PATH = join(dir, 'ai.db');
  process.env.GEMINI_API_KEY = 'test-key';
  let geminiAvailable = false;
  t.mock.method(globalThis, 'fetch', async () => {
    if (!geminiAvailable) return new Response(null, { status: 404 });
    const classification = { title: 'План для VPN', kind: 'idea', tags: [], confidence: 1 };
    return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(classification) }] } }] });
  });
  const { db, closeDb } = await import('../src/db.js');
  const { AiWorker } = await import('../src/aiWorker.js');
  const { classifyEntry } = await import('../src/classifier.js');
  t.after(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

  const ins = db.prepare('INSERT INTO entries (id,owner_id,original_text,title,kind,project,status,tags,ai_state,ai_attempts,next_ai_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  type Row = { id: string; owner_id: string; original_text: string; title: string; kind: string; project: string; tags: string; ai_state: string; ai_attempts: number; next_ai_at: string; created_at: string; updated_at: string };
  const getRow = (id: string) => db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as Row | undefined;

  // 1) Crash recovery: pending rows left by a dead process are classified by a fresh worker.
  ins.run(UUID1, '9', 'Идея: переключить VPN', 'Идея: переключить VPN', 'note', 'Inbox', 'inbox', '[]', 'pending', 0, '', NOW(), NOW());
  const w1 = new AiWorker(db, { pollMs: 50 });
  w1.start();
  await waitFor(() => getRow(UUID1)?.ai_state === 'done', 10_000);
  w1.stop();
  const r1 = getRow(UUID1)!;
  assert.equal(r1.original_text, 'Идея: переключить VPN', 'original_text must never change');
  assert.equal(r1.kind, 'idea');
  assert.equal(r1.classification_source, 'rules', 'provider outage must be visible as rules fallback');
  assert.equal(r1.ai_attempts, 0, 'a successful classification does not count as an attempt');

  // 2) A second worker instance (simulated restart) recovers another pending row.
  geminiAvailable = true;
  ins.run(UUID2, '9', 'задача: написать отчёт', 'задача: написать отчёт', 'note', 'Inbox', 'inbox', '[]', 'pending', 0, '', NOW(), NOW());
  const w2 = new AiWorker(db, { pollMs: 50 });
  w2.start();
  await waitFor(() => getRow(UUID2)?.ai_state === 'done', 10_000);
  w2.stop();
  assert.equal(getRow(UUID2)!.kind, 'idea');
  assert.equal(getRow(UUID2)!.classification_source, 'gemini');
  geminiAvailable = false;

  // 3) Backoff: a row that cannot be classified (empty text defeats both classifiers)
  //    gets next_ai_at in the future and is NOT retried immediately (no fast retry loop).
  ins.run(UUID3, '9', '', '', 'note', 'Inbox', 'inbox', '[]', 'pending', 0, '', NOW(), NOW());
  const w3 = new AiWorker(db, { pollMs: 50, maxAttempts: 5 });
  w3.start();
  await waitFor(() => (getRow(UUID3)?.ai_attempts ?? 0) >= 1, 10_000);
  w3.stop();
  const r3 = getRow(UUID3)!;
  assert.equal(r3.ai_state, 'pending', 'one failed attempt keeps the row pending');
  assert.ok(String(r3.next_ai_at) > NOW(), 'next_ai_at must be in the future (backoff)');
  assert.equal(r3.ai_attempts, 1);

  // 4) Max attempts: after maxAttempts failures the row is marked failed (no infinite retries).
  db.prepare('UPDATE entries SET ai_attempts = 4, next_ai_at = ? WHERE id = ?').run('', UUID3); // make it due now
  const w4 = new AiWorker(db, { pollMs: 50, maxAttempts: 5 });
  w4.start();
  await waitFor(() => getRow(UUID3)?.ai_state === 'failed', 10_000);
  w4.stop();
  assert.equal(getRow(UUID3)!.ai_attempts, 5);
  assert.equal(getRow(UUID3)!.ai_state, 'failed');

  // 5) Optimistic concurrency: a deleted entry is skipped, not resurrected or miscounted.
  ins.run(UUID4, '9', 'желание: съездить в море', 'желание: съездить в море', 'note', 'Inbox', 'inbox', '[]', 'pending', 0, '', NOW(), NOW());
  const snapshot4 = getRow(UUID4)!;
  db.prepare('DELETE FROM entries WHERE id = ?').run(UUID4);
  assert.equal(await classifyEntry(snapshot4, db), 'skipped');
  assert.equal(getRow(UUID4), undefined, 'deleted entry stays deleted');

  // 6) Optimistic concurrency: a concurrently modified entry (stale updated_at) is skipped.
  ins.run(UUID5, '9', 'событие: концерт 12.12', 'событие: концерт 12.12', 'note', 'Inbox', 'inbox', '[]', 'pending', 0, '', NOW(), NOW());
  const snapshot5 = getRow(UUID5)!;
  // Advance updated_at by a full second — NOW() alone can land in the same
  // millisecond as the snapshot, which would defeat the optimistic guard.
  const changedAt = new Date(Date.parse(snapshot5.updated_at) + 1000).toISOString();
  db.prepare('UPDATE entries SET title = ?, updated_at = ? WHERE id = ?').run('изменено пользователем', changedAt, UUID5);
  assert.equal(await classifyEntry(snapshot5, db), 'skipped');
  const r5 = getRow(UUID5)!;
  assert.equal(r5.title, 'изменено пользователем', 'manual edit wins over stale classification');
  assert.equal(r5.ai_state, 'pending', 'skipped row stays pending for a future retry');
});
