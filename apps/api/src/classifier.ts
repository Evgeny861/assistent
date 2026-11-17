import type { Database } from 'better-sqlite3';
import { z } from 'zod';

// Classification is OPTIONAL and never blocks saving.
// Deterministic rules first (this is not AI); Gemini behind the same interface when configured.
// On provider failure: entry keeps ai_state='pending' and its original text.

export const KINDS = ['note', 'idea', 'wish', 'task', 'event', 'purchase'] as const;
export type Kind = (typeof KINDS)[number];

export const classificationSchema = z.object({
  title: z.string().trim().min(1).max(180),
  kind: z.enum(KINDS),
  project: z.string().trim().min(1).max(100).optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(8).default([]),
  confidence: z.number().min(0).max(1),
});
export type Classification = z.infer<typeof classificationSchema>;

export interface Classifier {
  name: string;
  classify(text: string, existingProjects: string[]): Promise<Classification | null>;
}

export const projectAllowlist: string[] = (process.env.PROJECT_ALLOWLIST || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Simple deterministic fallback: explicit prefixes and Russian/English keywords.
// Deterministic and offline; never throws.
export const deterministicClassifier: Classifier = {
  name: 'deterministic',
  async classify(text: string): Promise<Classification | null> {
    const t = text.trim();
    if (!t) return null;
    const lower = t.toLowerCase();
    const m = t.match(/^(\s*(?:идея|idea|задача|task|желание|wish|событие|event|покупка|purchase))[:\-–—\s]+(.+)/i);
    const body = m ? m[2].trim() : t;
    let kind: Kind = 'note';
    if (m) {
      const kw = m[1].toLowerCase();
      kind = /^(идея|idea)/.test(kw) ? 'idea'
        : /^(задача|task)/.test(kw) ? 'task'
        : /^(желание|wish)/.test(kw) ? 'wish'
        : /^(событие|event)/.test(kw) ? 'event'
        : 'purchase';
    } else if (/(?<![а-яёa-z0-9])(хочу|хочется|хотел|хотела|хотим|мечтаю|мечтай)(?![а-яёa-z0-9])/u.test(lower)) kind = 'wish';
    else if (/(?<![а-яёa-z0-9])(надо|нужно|нужен|должен|следует|сделать|записать в план|не забыть)(?![а-яёa-z0-9])/u.test(lower)) kind = 'task';
    else if (/(?<![а-яёa-z0-9])(идея|придумал|придумала|предлагаю|можно бы)(?![а-яёa-z0-9])/u.test(lower)) kind = 'idea';
    else if (/(?<![а-яёa-z0-9])(купить|заказать|привезти|сделать заказ)(?![а-яёa-z0-9])/u.test(lower)) kind = 'purchase';
    else if (/(?<![а-яёa-z0-9])(встреча|съездить|поехать|билет|вход в|\d{1,2}\.\d{1,2}\.?\d{0,2})(?![а-яёa-z0-9])/u.test(lower)) kind = 'event';

    let project: string | undefined;
    for (const p of projectAllowlist) {
      if (lower.includes(p.toLowerCase())) { project = p; break; }
    }

    const tags: string[] = [];
    const tagMatch = t.match(/#[\p{L}\p{N}_-]+/gu);
    if (tagMatch) tags.push(...tagMatch.map((x) => x.slice(1)).slice(0, 8));

    return classificationSchema.parse({
      title: body.slice(0, 90),
      kind,
      project,
      tags,
      confidence: m ? 0.6 : 0.35,
    });
  },
};

// Optional Gemini provider. Used only when GEMINI_API_KEY is set.
// ~10s timeout, single attempt (1 retry on 429/5xx), fail-open to null.
export class GeminiClassifier implements Classifier {
  name = 'gemini';
  private key: string;
  constructor() {
    this.key = process.env.GEMINI_API_KEY || '';
  }
  get enabled(): boolean {
    return !!this.key;
  }
  async classify(text: string, existingProjects: string[]): Promise<Classification | null> {
    if (!this.enabled || !text.trim()) return null;
    const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(this.key)}`;
    const prompt = [
      'You are a personal-memory assistant. Classify the user note below.',
      'Allowed kinds: ' + KINDS.join(', ') + '.',
      existingProjects.length ? 'Allowed projects: ' + existingProjects.join(', ') + '. Use one only if it clearly matches, otherwise omit project.' : 'Omit project unless the note names one clearly.',
      'Return ONLY JSON matching: {"title":string(<=90 chars),"kind":"one of the kinds","project"?:string,"tags":string[] (max 8),"confidence":number 0..1}',
      'Note: ' + text,
    ].join('\n');
    let attempt = 0;
    while (attempt < 2) {
      attempt += 1;
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok && (res.status === 429 || res.status >= 500) && attempt < 2) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        if (!res.ok) return null;
        const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
        const json = raw.startsWith('```') ? raw.replace(/^```[a-z]*\n?|```$/g, '').trim() : raw;
        return classificationSchema.safeParse(JSON.parse(json)).data ?? null;
      } catch {
        return null;
      }
    }
    return null;
  }
}

let provider: Classifier | null = null;
export function getClassifier(): Classifier {
  if (provider) return provider;
  const gemini = new GeminiClassifier();
  provider = gemini.enabled ? gemini : deterministicClassifier;
  return provider;
}

// Run the primary classifier, returning null on any failure. Never throws.
async function safeClassify(text: string, existing: string[]): Promise<Classification | null> {
  try {
    return await getClassifier().classify(text, existing);
  } catch {
    return null;
  }
}

// Apply a validated classification to an entry. Never throws.
// Optimistic concurrency: applies only if the entry is still pending and unmodified
// (updated_at unchanged) since the snapshot was taken — a manual edit or a delete wins.
// Falls back to the deterministic classifier when the primary provider fails, so a
// note is never stuck because of an external AI outage.
// Returns: 'done' = applied; 'skipped' = entry deleted/changed/not pending; 'failed' = no classifier produced a result.
export async function classifyEntry(entry: { id: string; owner_id: string; original_text: string; title: string; kind: string; project: string; tags: string; ai_state: string; updated_at: string }, db: Database): Promise<'done' | 'skipped' | 'failed'> {
  if (entry.ai_state !== 'pending') return 'skipped';
  try {
    const existing = db.prepare('SELECT DISTINCT project FROM entries WHERE owner_id = ? AND project != \'Inbox\'').all(entry.owner_id) as { project: string }[];
    const existingProjects = existing.map((r) => r.project);
    let result = await safeClassify(entry.original_text, existingProjects);
    if (!result) {
      // Requirement: when the external AI is unavailable, use the deterministic classifier.
      try { result = await deterministicClassifier.classify(entry.original_text, existingProjects); } catch { /* stays null */ }
    }
    if (!result) return 'failed';
    let project = result.project;
    if (project && project !== 'Inbox') {
      const p = project;
      if (!existingProjects.includes(p) && !projectAllowlist.some((a) => a.toLowerCase() === p.toLowerCase())) {
        project = undefined; // drop unknown project, keep current
      }
    }
    const now = new Date().toISOString();
    const tags = result.tags.length ? JSON.stringify(result.tags) : entry.tags;
    const res = db.prepare('UPDATE entries SET title=?, kind=?, project=?, tags=?, ai_state=\'done\', updated_at=? WHERE id=? AND owner_id=? AND ai_state=\'pending\' AND updated_at=?')
      .run(result.title, result.kind, project || entry.project, tags, now, entry.id, entry.owner_id, entry.updated_at);
    return res.changes > 0 ? 'done' : 'skipped';
  } catch {
    return 'failed'; // fail-open: entry stays pending, original text untouched
  }
}
