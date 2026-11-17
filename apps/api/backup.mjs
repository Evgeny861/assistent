#!/usr/bin/env node
// WAL-safe SQLite backup and restore for IdeaFlow.
//
//   node apps/api/backup.mjs backup  [source.db] [out.db]
//   node apps/api/backup.mjs restore [backup.db] [target.db]
//
// backup : VACUUM INTO — consistent single-file snapshot of a (possibly live, WAL-mode) DB.
// restore: VACUUM INTO from the backup into a fresh target file (never overwrites in place).
// Both modes are read-only with respect to the source database.

import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const [mode, a, b] = process.argv.slice(2);
if (mode !== 'backup' && mode !== 'restore') {
  console.error('Usage: node apps/api/backup.mjs backup [source.db] [out.db]');
  console.error('       node apps/api/backup.mjs restore [backup.db] [target.db]');
  process.exit(2);
}

const src = resolve(a || (mode === 'backup' ? './data/ideaflow.db' : ''));
const dst = resolve(b || '');
if (!src || !dst) { console.error('missing source or target path'); process.exit(2); }
if (mode === 'restore' && src === dst) { console.error('target must differ from source'); process.exit(2); }
if (!existsSync(src)) { console.error('source not found: ' + src); process.exit(1); }
mkdirSync(dirname(dst), { recursive: true });
if (existsSync(dst)) { console.error('target already exists (refusing to overwrite): ' + dst); process.exit(1); }

// Open the source read-only: a live WAL database can be snapshotted this way.
const ro = new Database(src, { readonly: true });
try {
  ro.prepare('VACUUM INTO ?').run(dst);
} finally {
  ro.close();
}

// Integrity check of the produced file.
const chk = new Database(dst, { readonly: true });
let ok = 'ok';
try {
  const row = chk.prepare('PRAGMA integrity_check').get();
  ok = row.integrity_check;
  const count = chk.prepare('SELECT COUNT(*) AS n FROM entries').get().n;
  const mig = chk.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v;
  console.log(`${mode} OK: ${dst} (entries: ${count}, schema: v${mig}, integrity: ${ok})`);
} catch (e) {
  ok = String(e);
} finally {
  chk.close();
}
process.exit(ok === 'ok' ? 0 : 1);
