import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Classification, Classifier } from './classifier.js';

const file = process.env.DB_PATH || './data/ideaflow.db';
mkdirSync(dirname(file), { recursive: true });
export const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

// Versioned schema migrations. Each runs once, tracked in schema_migrations.
type Migration = { version: number; up: () => void };
const migrations: Migration[] = [
  {
    version: 1,
    up: () => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS entries (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          original_text TEXT NOT NULL,
          title TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'note',
          project TEXT NOT NULL DEFAULT 'Inbox',
          status TEXT NOT NULL DEFAULT 'inbox',
          tags TEXT NOT NULL DEFAULT '[]',
          ai_state TEXT NOT NULL DEFAULT 'pending',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_entries_owner_created ON entries(owner_id, created_at DESC);
      `);
    },
  },
  {
    // Align with the planned data model: original_text is the immutable capture text.
    // Also add the owner+kind and owner+status indices from the plan.
    version: 2,
    up: () => {
      const hasText = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='entries'").get();
      if (!hasText) return;
      const cols = db.prepare('PRAGMA table_info(entries)').all() as { name: string }[];
      if (cols.some((c) => c.name === 'text') && !cols.some((c) => c.name === 'original_text')) {
        db.exec('ALTER TABLE entries RENAME COLUMN text TO original_text');
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_entries_owner_kind ON entries(owner_id, kind);
        CREATE INDEX IF NOT EXISTS idx_entries_owner_status ON entries(owner_id, status);
      `);
    },
  },
  {
    // AI retry/recovery bookkeeping. Empty next_ai_at = due now.
    version: 3,
    up: () => {
      const cols = db.prepare('PRAGMA table_info(entries)').all() as { name: string }[];
      if (!cols.some((c) => c.name === 'ai_attempts')) db.exec('ALTER TABLE entries ADD COLUMN ai_attempts INTEGER NOT NULL DEFAULT 0');
      if (!cols.some((c) => c.name === 'next_ai_at')) db.exec('ALTER TABLE entries ADD COLUMN next_ai_at TEXT NOT NULL DEFAULT \'\'');
    },
  },
  {
    // Telegram update dedup: guarantees at-most-once entry creation per update id
    // across process restarts (long polling redelivers updates before ack timeout).
    version: 4,
    up: () => {
      db.exec('CREATE TABLE IF NOT EXISTS tg_updates (update_id INTEGER PRIMARY KEY, processed_at TEXT NOT NULL)');
    },
  },
  {
    version: 5,
    up: () => {
      db.exec(`
        ALTER TABLE entries ADD COLUMN manual_fields TEXT NOT NULL DEFAULT '{}';
        ALTER TABLE entries ADD COLUMN classification_source TEXT;
        -- Older pending rows that changed may contain manual edits. Preserve all their existing fields.
        UPDATE entries SET manual_fields = '{"title":true,"kind":true,"project":true,"tags":true}'
          WHERE ai_state = 'pending' AND updated_at <> created_at;
      `);
    },
  },
  {
    version: 6,
    up: () => {
      db.exec(`
        CREATE TABLE telegram_drafts (
          owner_id TEXT PRIMARY KEY,
          revision TEXT NOT NULL,
          message_id INTEGER,
          state TEXT NOT NULL
        );
      `);
    },
  },
];
function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const apply = db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)');
  const tx = db.transaction(() => {
    for (const m of migrations) {
      const done = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(m.version);
      if (!done) { m.up(); apply.run(m.version, new Date().toISOString()); }
    }
  });
  tx();
}
migrate();

export type Entry = {
  id: string; owner_id: string; original_text: string; title: string;
  kind: string; project: string; status: string; tags: string;
  ai_state: string; classification_source: 'gemini' | 'rules' | null; created_at: string; updated_at: string;
};
const INSERT_SQL = `INSERT INTO entries (id,owner_id,original_text,title,kind,project,status,tags,ai_state,classification_source,created_at,updated_at)
  VALUES (@id,@owner_id,@original_text,@title,@kind,@project,@status,@tags,@ai_state,@classification_source,@created_at,@updated_at)`;
const SELECT_SQL = 'SELECT id, owner_id, original_text, title, kind, project, status, tags, ai_state, classification_source, created_at, updated_at FROM entries WHERE owner_id = ? ORDER BY created_at DESC';
export function listEntries(owner: string): Entry[] {
  return db.prepare(SELECT_SQL).all(owner) as Entry[];
}
export function addEntry(
  owner: string,
  text: string,
  database = db,
  completed?: { classification: Classification; source: Classifier['name'] },
): Entry {
  const now = new Date().toISOString();
  const classification = completed?.classification;
  const entry: Entry = {
    id: randomUUID(), owner_id: owner, original_text: text,
    title: classification?.title ?? text.trim().slice(0, 90),
    kind: classification?.kind ?? 'note', project: classification?.project ?? 'Inbox',
    status: 'inbox', tags: JSON.stringify(classification?.tags ?? []),
    ai_state: completed ? 'done' : 'pending', classification_source: completed?.source ?? null,
    created_at: now, updated_at: now,
  };
  database.prepare(INSERT_SQL).run(entry);
  return entry;
}
export function closeDb() {
  try { db.close(); } catch { /* already closed */ }
}
