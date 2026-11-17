import { Bot } from 'grammy';
import type { Database } from 'better-sqlite3';
import { addEntry } from './db.js';

export interface TelegramBotLog {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

export interface TelegramBotOptions {
  token: string;
  db: Database;
  log: TelegramBotLog;
  /** If set, a "Open Mini App" inline button links to this origin. */
  webOrigin?: string;
  /** Override the Telegram API root URL (tests only; defaults to https://api.telegram.org). */
  apiBaseURL?: string;
  /** Called after an entry is committed (wakes the AiWorker for prompt classification). */
  onEntrySaved?: () => void;
}

// Single-instance bot (by design: no second polling consumer).
// At-most-once per Telegram update: long polling redelivers updates until they are
// answered or the 24h ack window passes, so a crash between save and reply would
// otherwise create a duplicate.
export function startTelegramBot({ token, db, log, webOrigin, apiBaseURL, onEntrySaved }: TelegramBotOptions): Bot {
  const bot = apiBaseURL
    ? new Bot(token, { client: { apiRoot: apiBaseURL } })
    : new Bot(token);
  // `web_app` (not plain `url`): only a Web App button makes Telegram inject
  // initData into the opened app, which the API requires for auth.
  const miniAppButton = webOrigin
    ? { reply_markup: { inline_keyboard: [[{ text: '📂 Открыть приложение', web_app: { url: webOrigin } }]] } }
    : undefined;
  bot.command('start', (ctx) =>
    ctx.reply('Отправь мне мысль — я сохраню её во входящие и автоматически разберу. Приложение открывается кнопкой ниже.', miniAppButton));
  bot.command('help', (ctx) =>
    ctx.reply('Просто отправляйте текст — каждая мысль сохраняется как запись (оригинал никогда не меняется). Кнопка «Открыть приложение» ведёт в Mini App: просмотр, поиск, редактирование, экспорт. Команды: /start, /help.', miniAppButton));
  const claimUpdate = db.prepare('INSERT OR IGNORE INTO tg_updates (update_id, processed_at) VALUES (?, ?)');
  bot.on('message:text', async (ctx) => {
    if (ctx.chat.type !== 'private') return; // group mode is not supported
    const userId = ctx.from?.id;
    if (typeof userId !== 'number') return;
    const claim = claimUpdate.run(ctx.update.update_id, new Date().toISOString());
    if (claim.changes === 0) return; // this update was already saved
    const text = ctx.message.text.trim();
    if (!text || text.startsWith('/')) return;
    if (text.length > 4096) return void ctx.reply('Слишком длинное сообщение, разбейте его на части.');
    addEntry(String(userId), text); // committed synchronously; AiWorker classifies it
    onEntrySaved?.(); // wake the AiWorker so classification is prompt
    // Acknowledge only after the entry is committed to SQLite (addEntry is synchronous).
    await ctx.reply('✅ Сохранено во входящие');
  });
  // Never surface internal stack traces to the user.
  bot.catch((err) => {
    log.error({ err: (err as Error).message }, 'Telegram update error');
    const ctx = (err as { ctx?: { reply?: (t: string) => Promise<unknown> } }).ctx;
    if (ctx?.reply) void ctx.reply('Не получилось обработать сообщение, попробуйте ещё раз.');
  });
  bot.start({ onStart: () => log.info('Telegram polling started') })
    .catch((err) => log.error({ err }, 'Telegram bot failed'));
  return bot;
}
