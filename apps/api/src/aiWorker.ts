import type { Database } from 'better-sqlite3';
import { classifyEntry } from './classifier.js';

const DEFAULTS = { pollMs: 5_000, maxAttempts: 5, concurrency: 2 };
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 30 * 60_000;
const BATCH = 8;

type AiRow = { id: string; owner_id: string; original_text: string; title: string; kind: string; project: string; tags: string; ai_state: string; updated_at: string; ai_attempts: number };

// Recovers entries left in ai_state='pending' (e.g. after a crash or restart) and
// retries unclassified entries with exponential backoff. Single process by design:
// the in-flight set guarantees one entry is never classified in parallel.
// Never deletes or modifies original_text.
export class AiWorker {
  private inFlight = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private opts: Required<typeof DEFAULTS>;

  constructor(private db: Database, opts: Partial<typeof DEFAULTS> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  start(): void {
    if (this.timer) return;
    // Recover pending work right after startup instead of waiting for the first tick.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  // Wake the worker right after a new pending entry is committed (POST /
  // Telegram save), so classification is prompt instead of waiting for the
  // next 5 s tick. The periodic timer remains as the crash-recovery safety net.
  kick(): void {
    if (this.timer) void this.tick();
  }

  private backoffMs(attempts: number): number {
    return Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS);
  }

  private async tick(): Promise<void> {
    try {
      const now = new Date().toISOString();
      const rows = this.db.prepare(
        'SELECT id, owner_id, original_text, title, kind, project, tags, ai_state, updated_at, ai_attempts FROM entries WHERE ai_state = \'pending\' AND (next_ai_at = \'\' OR next_ai_at <= ?) ORDER BY created_at ASC LIMIT ' + BATCH
      ).all(now) as AiRow[];
      for (const row of rows) {
        if (this.inFlight.size >= this.opts.concurrency) break;
        if (this.inFlight.has(row.id)) continue;
        this.inFlight.add(row.id);
        void this.process(row);
      }
      // Housekeeping: processed Telegram update marks older than 24h are no longer needed.
      this.db.prepare('DELETE FROM tg_updates WHERE processed_at < ?')
        .run(new Date(Date.now() - 24 * 3600 * 1000).toISOString());
    } catch {
      // Keep ticking: a failed pass must not kill the recovery loop.
    }
  }

  private async process(row: AiRow): Promise<void> {
    try {
      const outcome = await classifyEntry(row, this.db);
      if (outcome === 'failed') {
        const attempts = row.ai_attempts + 1;
        if (attempts >= this.opts.maxAttempts) {
          this.db.prepare('UPDATE entries SET ai_state=\'failed\', ai_attempts=? WHERE id=? AND owner_id=? AND ai_state=\'pending\'')
            .run(attempts, row.id, row.owner_id);
        } else {
          this.db.prepare('UPDATE entries SET ai_attempts=?, next_ai_at=? WHERE id=? AND owner_id=? AND ai_state=\'pending\'')
            .run(attempts, new Date(Date.now() + this.backoffMs(attempts)).toISOString(), row.id, row.owner_id);
        }
      }
      // 'done'/'skipped' need no bookkeeping: the entry is either resolved or no longer pending.
    } finally {
      this.inFlight.delete(row.id);
    }
  }
}
