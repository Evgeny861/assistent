import type { Database } from 'better-sqlite3';
import { GrammyError, InlineKeyboard } from 'grammy';
import type { Api } from 'grammy';
import { isTelegramUserAllowed } from './auth.js';
import { formatReminder } from './reminderTime.js';

const leaseMs = 60_000;
const requestTimeoutMs = 10_000;
const pollMs = 5_000;
const snoozeMs = 10 * 60_000;

export type ScheduledReminder = {
  entry_id: string;
  owner_id: string;
  chat_id: number;
  title: string;
  due_at: number;
  time_zone: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'cancelled';
  attempts: number;
};

export function reminders(db: Database) {
  const active = db.prepare(`
    SELECT r.*, e.title FROM reminders r JOIN entries e ON e.id = r.entry_id
    WHERE r.owner_id = ? AND r.status IN ('pending', 'sending', 'failed')
    ORDER BY r.due_at LIMIT 11
  `);
  const cancel = db.prepare(`
    UPDATE reminders SET status = 'cancelled'
    WHERE entry_id = ? AND owner_id = ? AND status IN ('pending', 'failed')
  `);
  const snooze = db.prepare(`
    UPDATE reminders SET status = 'pending', due_at = ?, next_attempt_at = ?, telegram_message_id = NULL, attempts = 0
    WHERE entry_id = ? AND owner_id = ? AND status = 'sent' AND telegram_message_id = ?
      AND EXISTS (SELECT 1 FROM entries WHERE id = reminders.entry_id AND status IN ('inbox', 'active'))
    RETURNING time_zone
  `);
  const done = db.prepare(`
    UPDATE entries SET status = 'done', updated_at = ?
    WHERE id = ? AND owner_id = ? AND status IN ('inbox', 'active')
      AND EXISTS (
        SELECT 1 FROM reminders WHERE entry_id = entries.id AND status = 'sent' AND telegram_message_id = ?
      )
  `);

  return {
    active: (owner: string) => active.all(owner) as ScheduledReminder[],
    cancel: (id: string, owner: string) => cancel.run(id, owner).changes === 1,
    snooze(id: string, owner: string, messageId: number) {
      const dueAt = Date.now() + snoozeMs;
      const row = snooze.get(dueAt, dueAt, id, owner, messageId) as { time_zone: string } | undefined;
      if (row) return { dueAt, timeZone: row.time_zone };
    },
    done: (id: string, owner: string, messageId: number) =>
      done.run(new Date().toISOString(), id, owner, messageId).changes === 1,
  };
}

export function startReminderDelivery(
  db: Database,
  api: Pick<Api, 'sendMessage'>,
  log: { error: (object: unknown, message?: string) => void },
  interval = pollMs,
) {
  const take = db.prepare(`
    UPDATE reminders
    SET status = 'sending', lease_until = @lease, attempts = attempts + 1
    WHERE entry_id = (
      SELECT entry_id FROM reminders
      WHERE (status = 'pending' AND next_attempt_at <= @now)
         OR (status = 'sending' AND lease_until <= @now)
      ORDER BY due_at LIMIT 1
    )
    RETURNING *
  `);
  const title = db.prepare("SELECT title FROM entries WHERE id = ? AND status IN ('inbox', 'active')");
  const finish = db.prepare(`
    UPDATE reminders SET status = ?, telegram_message_id = ?, next_attempt_at = ?, lease_until = NULL
    WHERE entry_id = ? AND status = 'sending' AND lease_until = ?
  `);

  let busy: Promise<void> | undefined;
  async function deliver() {
    for (let i = 0; i < 20 && !stopping; i++) {
      const now = Date.now();
      const lease = now + leaseMs;
      const reminder = take.get({ now, lease }) as ScheduledReminder | undefined;
      if (!reminder) return;
      const entry = title.get(reminder.entry_id) as { title: string } | undefined;
      if (!entry || !isTelegramUserAllowed(reminder.owner_id)) {
        finish.run('cancelled', null, 0, reminder.entry_id, lease);
        continue;
      }
      const keyboard = new InlineKeyboard()
        .text('✓ Готово', `rem:${reminder.entry_id}:d`)
        .text('Через 10 минут', `rem:${reminder.entry_id}:z`);
      // grammY's type refers to its AbortSignal polyfill. Node's native signal is compatible at runtime.
      const signal = AbortSignal.timeout(requestTimeoutMs) as unknown as Parameters<Api['sendMessage']>[3];
      let message;
      try {
        message = await api.sendMessage(reminder.chat_id,
          `🔔 ${entry.title}\n${formatReminder(reminder.due_at, reminder.time_zone)}`,
          { reply_markup: keyboard }, signal);
      } catch (error) {
        const code = error instanceof GrammyError ? error.error_code : undefined;
        const permanent = code != null && code >= 400 && code < 500 && code !== 429;
        const retryAfter = error instanceof GrammyError ? error.parameters.retry_after : undefined;
        const delay = Math.max((retryAfter ?? 0) * 1000, Math.min(60 * 60_000, 15_000 * 2 ** Math.min(reminder.attempts - 1, 8)));
        finish.run(permanent ? 'failed' : 'pending', null, Date.now() + delay, reminder.entry_id, lease);
        log.error({ code, attempts: reminder.attempts }, 'Telegram reminder delivery failed');
        continue;
      }
      finish.run('sent', message.message_id, 0, reminder.entry_id, lease);
    }
  }

  let stopping = false;
  const tick = () => {
    if (stopping || busy) return;
    busy = deliver().catch(() => log.error({}, 'Reminder worker failed')).finally(() => { busy = undefined; });
  };
  const timer = setInterval(tick, interval);
  timer.unref();
  tick();
  return {
    async stop() {
      stopping = true;
      clearInterval(timer);
      await busy;
    },
  };
}
