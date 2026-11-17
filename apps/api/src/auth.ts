import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
// TEMP DEBUG (removed after determining the correct HMAC variant):
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { appendFileSync as _appendFileSync } from 'node:fs';

// Telegram Mini App initData validation (server-side, never trust the client):
// secret = HMAC_SHA256(bot_token, "WebAppData"), hash = HMAC_SHA256(secret, sorted key=value lines).
// Freshness: auth_date within 1 hour of now.
const MAX_AGE_SEC = 3600;

export function validateInitData(initData: string, botToken: string): string | null {
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  const authDate = Number(p.get('auth_date'));
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null;
  if (!Number.isFinite(authDate) || Math.abs(Date.now() / 1000 - authDate) > MAX_AGE_SEC) return null;
  p.delete('hash'); p.delete('signature');
  const check = [...p.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  // TEMP DEBUG: determine the correct Telegram HMAC variant against live initData.
  // Local file only; no initData or token content is logged.
  try {
    const secretA = createHmac('sha256', botToken).update('WebAppData').digest();
    const secretB = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const hA = createHmac('sha256', secretA).update(check).digest('hex');
    const hB = createHmac('sha256', secretB).update(check).digest('hex');
    const rawHead = initData; // as received: percent-encoded query string (or plain)
    const decoded = decodeURIComponent(initData);
    const uid = JSON.parse(p.get('user') || 'null')?.id ?? 'n/a';
    // Alternative check strings for comparison:
    const noSort = [...p.entries()].map(([k, v]) => `${k}=${v}`).join('\n');
    let sortCode = [...p.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join('\n');
    // Truly raw pairs from the AS-RECEIVED header (no decoding):
    let rawPairs: string[] = [];
    for (const pair of rawHead.split('&')) {
      const i = pair.indexOf('=');
      rawPairs.push(i < 0 ? `${pair}=` : pair);
    }
    const rawSorted = [...rawPairs].sort().join('\n');
    // decoded value, raw key — in case only keys stay literal:
    const mixed = [...p.entries()].map(([k, v]) => `${k}=${(rawPairs.find((rp) => rp.startsWith(k + '=')) || `${k}=`).slice(k.length + 1)}`).join('\n');
    const mixedSorted = [...[...p.entries()].map(([k]) => k)].sort().map((k) => `${k}=${(rawPairs.find((rp) => rp.startsWith(k + '=')) || `${k}=`).slice(k.length + 1)}`).join('\n');
    const f = (s: string) => createHmac('sha256', s).update('x').digest('hex').slice(0, 8);
    _appendFileSync('C:/Users/tunni/AppData/Local/Temp/if-tunnel/authdebug.log',
      `${new Date().toISOString()} auth_date=${authDate} user=${uid} received=${String(hash).slice(0, 8)} ` +
      `match_A=${hA === String(hash).toLowerCase()} match_B=${hB === String(hash).toLowerCase()} ` +
      `keys=[${[...p.keys()].sort().join(',')}] qlen=${(p.get('query_id') || '').length} ` +
      `checkFingerprint=${f(check)} rawLen=${rawHead.length} decLen=${decoded.length} ` +
      `alt_rawsorted=${createHmac('sha256', secretA).update(rawSorted).digest('hex') === String(hash).toLowerCase()} ` +
      `alt_raworder=${createHmac('sha256', secretA).update(rawPairs.join('\n')).digest('hex') === String(hash).toLowerCase()} ` +
      `alt_mixedSorted=${createHmac('sha256', secretA).update(mixedSorted).digest('hex') === String(hash).toLowerCase()} ` +
      `alt_decodedRawOrder=${createHmac('sha256', secretA).update(decoded).digest('hex') === String(hash).toLowerCase()} ` +
      `rawHeadFP=${createHash('sha256').update(rawHead).digest('hex').slice(0, 12)}\n`);
  } catch { /* ignore */ }
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
