import { randomUUID } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { addEntry } from './db.js';
import type { ConversationState } from './conversation.js';

type DraftRow = { revision: string; message_id: number | null; state: string };
export type TelegramDraft = { revision: string; messageId: number | null; state: ConversationState };

export function getDecision(draft: TelegramDraft) {
  return draft.state.turns.at(-1)?.decision;
}

export function telegramDrafts(db: Database) {
  const select = db.prepare('SELECT revision, message_id, state FROM telegram_drafts WHERE owner_id = ?');
  const replace = db.prepare(`
    INSERT INTO telegram_drafts (owner_id, revision, state) VALUES (?, ?, ?)
    ON CONFLICT(owner_id) DO UPDATE SET revision = excluded.revision, message_id = NULL, state = excluded.state
  `);
  const update = db.prepare('UPDATE telegram_drafts SET state = ? WHERE owner_id = ? AND revision = ?');
  const attach = db.prepare('UPDATE telegram_drafts SET message_id = ? WHERE owner_id = ? AND revision = ?');
  const remove = db.prepare('DELETE FROM telegram_drafts WHERE owner_id = ? AND revision = ?');
  const claimUpdate = db.prepare('INSERT OR IGNORE INTO tg_updates (update_id, processed_at) VALUES (?, ?)');

  function get(owner: string): TelegramDraft | undefined {
    const row = select.get(owner) as DraftRow | undefined;
    if (row) return { revision: row.revision, messageId: row.message_id, state: JSON.parse(row.state) as ConversationState };
  }

  function begin(owner: string, text: string, previous?: TelegramDraft): TelegramDraft {
    const revision = randomUUID();
    const state: ConversationState = {
      originalText: previous?.state.originalText ?? text,
      turns: [...(previous?.state.turns.slice(-5) ?? []), { text }],
    };
    replace.run(owner, revision, JSON.stringify(state));
    return { revision, state, messageId: null };
  }

  const confirm = db.transaction((owner: string, revision: string) => {
    const draft = get(owner);
    if (draft?.revision !== revision || !draft.state.source || draft.state.reminder) return;
    const decision = getDecision(draft);
    if (decision?.action !== 'draft') return;
    const entry = addEntry(owner, draft.state.originalText, db, {
      classification: decision.classification,
      source: draft.state.source,
    });
    remove.run(owner, revision);
    return entry;
  });

  const schedule = db.prepare(`
    INSERT INTO reminders (entry_id, owner_id, chat_id, due_at, time_zone, next_attempt_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const confirmReminder = db.transaction((owner: string, revision: string, chatId: number) => {
    const draft = get(owner);
    const reminder = draft?.state.reminder;
    if (draft?.revision !== revision || !reminder || reminder.question || !reminder.draft.dueAt) return;
    const { dueAt, timeZone, title } = reminder.draft;
    if (dueAt <= Date.now()) return { expired: true } as const;
    const entry = addEntry(owner, draft.state.originalText, db, {
      classification: { title, kind: 'task', tags: [], confidence: 1 },
      source: 'rules',
    });
    schedule.run(entry.id, owner, chatId, dueAt, timeZone, dueAt);
    remove.run(owner, revision);
    return { expired: false, title, dueAt, timeZone } as const;
  });

  return {
    get,
    begin,
    confirm,
    confirmReminder,
    claim: (id: number) => claimUpdate.run(id, new Date().toISOString()).changes === 1,
    update: (owner: string, revision: string, state: ConversationState) => update.run(JSON.stringify(state), owner, revision).changes === 1,
    attach: (owner: string, revision: string, messageId: number) => attach.run(messageId, owner, revision).changes === 1,
    remove: (owner: string, revision: string) => remove.run(owner, revision),
  };
}
