import { createHmac, timingSafeEqual } from 'node:crypto';

// Telegram Mini App initData validation (server-side, never trust the client):
// Use "WebAppData" as the HMAC key and the bot token as the message to derive the secret.
// Freshness: auth_date within 1 hour of now.
const MAX_AGE_SEC = 3600;

export function validateInitData(initData: string, botToken: string): string | null {
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  const authDate = Number(p.get('auth_date'));
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null;
  if (!Number.isFinite(authDate) || Math.abs(Date.now() / 1000 - authDate) > MAX_AGE_SEC) return null;
  // Bot-token HMAC covers every field except hash, including signature if present.
  p.delete('hash');
  p.sort();
  const check = [...p.entries()].map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const actual = createHmac('sha256', secret).update(check).digest();
  let candidate: Buffer;
  try { candidate = Buffer.from(hash, 'hex'); } catch { return null; }
  if (candidate.length !== actual.length || !timingSafeEqual(candidate, actual)) return null;
  let user: { id?: unknown };
  try { user = JSON.parse(p.get('user') || 'null') ?? {}; } catch { return null; }
  return typeof user.id === 'number' && Number.isSafeInteger(user.id) && user.id > 0 ? String(user.id) : null;
}

export function makeInitData(user: { id: number; first_name?: string }, botToken: string, ageSec = 0): string {
  const authDate = Math.floor(Date.now() / 1000) - ageSec;
  const params: Record<string, string> = { auth_date: String(authDate), query_id: 'AAE' + Math.random().toString(16).slice(2, 10) };
  if (user) params.user = JSON.stringify(user);
  const pairs = Object.entries(params).sort(([a], [b]) => a.localeCompare(b));
  const check = pairs.map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...params, hash }).toString();
}

// Dev-only owner resolution. NEVER active when NODE_ENV=production.
export function resolveOwner(headers: Record<string, unknown>, botToken: string | undefined, devMode: boolean): string | null {
  const initData = headers['x-telegram-init-data'];
  if (typeof initData === 'string' && initData.length > 0) {
    if (!botToken) return null;
    return validateInitData(initData, botToken);
  }
  if (devMode) return 'local-dev';
  return null;
}

const allowedTelegramUsers = new Set(
  (process.env.TELEGRAM_ALLOWED_USER_IDS ?? '').split(',').map((id) => id.trim()).filter(Boolean),
);

export function isTelegramUserAllowed(owner: string): boolean {
  return allowedTelegramUsers.size === 0 || allowedTelegramUsers.has(owner);
}
