import { Bot, Context, InlineKeyboard } from 'grammy';
import type { Database } from 'better-sqlite3';
import { directSave, planConversation } from './conversation.js';
import { getExistingProjects, projectAllowlist } from './classifier.js';
import { getDecision, TelegramDraft, telegramDrafts } from './telegramDrafts.js';
import type { Entry } from './db.js';
import { isTelegramUserAllowed } from './auth.js';

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
}

// Single-instance bot. SQLite tracks text updates and the current draft revision,
// so a redelivery or an old button cannot confirm a draft twice.
export function startTelegramBot({ token, db, log, webOrigin, apiBaseURL }: TelegramBotOptions): Bot {
  const bot = apiBaseURL
    ? new Bot(token, { client: { apiRoot: apiBaseURL } })
    : new Bot(token);
  // `web_app` (not plain `url`): only a Web App button makes Telegram inject
  // initData into the opened app, which the API requires for auth.
  const miniAppButton = webOrigin
    ? { reply_markup: { inline_keyboard: [[{ text: '📂 Открыть приложение', web_app: { url: webOrigin } }]] } }
    : undefined;
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private' || !ctx.from || !isTelegramUserAllowed(String(ctx.from.id))) return;
    await next();
  });
  const drafts = telegramDrafts(db);
  const kindLabels = {
    note: 'Заметка', idea: 'Идея', wish: 'Желание', task: 'Задача', event: 'Событие', purchase: 'Покупка',
  };
  bot.command('start', (ctx) =>
    ctx.reply('Пришли мысль. Я предложу, как её записать, или задам вопрос. Можно поправить меня сообщением или нажать «✓ Сохранить».', miniAppButton));
  bot.command('help', (ctx) =>
    ctx.reply('Уточняй мысль обычным текстом. Чтобы сохранить, нажми «✓ Сохранить» или ответь «да». «Пока не сохраняй» отменяет черновик. Готовые записи доступны в приложении.', miniAppButton));

  async function clearKeyboard(ctx: Context, messageId: number | null | undefined) {
    if (messageId == null || !ctx.chat) return;
    try { await ctx.api.editMessageReplyMarkup(ctx.chat.id, messageId, { reply_markup: { inline_keyboard: [] } }); }
    catch { log.warn('Could not clear Telegram draft keyboard'); }
  }

  async function clearDraftKeyboard(ctx: Context, draft?: TelegramDraft) {
    const decision = draft && getDecision(draft);
    if (decision?.action === 'draft' || (decision?.action === 'clarify' && decision.choices.length)) {
      await clearKeyboard(ctx, draft?.messageId);
    }
  }

  async function showSaved(ctx: Context, draft: TelegramDraft, entry: Entry) {
    const project = entry.project === 'Inbox' ? 'во входящие' : `в «${entry.project}»`;
    const text = `✓ Сохранено ${project}\n${entry.title}`;
    if (draft.messageId != null && ctx.chat) {
      try {
        await ctx.api.editMessageText(ctx.chat.id, draft.messageId, text, { reply_markup: { inline_keyboard: [] } });
        return;
      } catch {
        await clearKeyboard(ctx, draft.messageId);
      }
    }
    await ctx.reply(text);
  }

  async function respond(ctx: Context, owner: string, draft: TelegramDraft, previous: TelegramDraft | undefined, saveDirectly: boolean) {
    await clearDraftKeyboard(ctx, previous);
    const projects = [...new Set([...getExistingProjects(db, owner), ...projectAllowlist])];
    const state = await planConversation(draft.state, projects);
    const decision = state.turns.at(-1)?.decision;
    if (!decision || !drafts.update(owner, draft.revision, state)) return;
    if (decision.action === 'draft' && saveDirectly) {
      const saved = drafts.confirm(owner, draft.revision);
      if (saved) await showSaved(ctx, draft, saved);
      return;
    }

    const keyboard = new InlineKeyboard();
    let text: string;
    if (decision.action === 'draft') {
      const { title, kind, project } = decision.classification;
      const placement = project && project !== 'Inbox'
        ? projects.includes(project) ? `Проект: «${project}».` : `Создам проект «${project}» при сохранении.`
        : '';
      text = [`Записать?`, `${kindLabels[kind]}: ${title}`, placement].filter(Boolean).join('\n');
      keyboard.text('✓ Сохранить', `draft:${draft.revision}:s`);
    } else if (decision.action === 'clarify') {
      text = decision.question;
      for (const [i, choice] of decision.choices.entries()) keyboard.text(choice, `draft:${draft.revision}:${i}`).row();
    } else {
      text = decision.text;
    }
    const hasKeyboard = keyboard.inline_keyboard.some((row) => row.length);
    const message = await ctx.reply(text, hasKeyboard ? { reply_markup: keyboard } : undefined);
    if (!drafts.attach(owner, draft.revision, message.message_id) && hasKeyboard) {
      await clearKeyboard(ctx, message.message_id);
    }
  }

  const takeText = db.transaction((updateId: number, owner: string, text: string, replyingTo?: number) => {
    if (!drafts.claim(updateId)) return { action: 'ignore' } as const;
    const previous = drafts.get(owner);
    if (replyingTo != null && replyingTo !== previous?.messageId) return { action: 'stale' } as const;
    const control = text.toLowerCase().replace(/[.!]+$/u, '').trim();
    const decision = previous && getDecision(previous);
    if (/^(?:да(?:,?\s+(?:запиши|сохрани))?|подтверждаю|сохрани|запиши)$/u.test(control)) {
      if (!previous) return { action: 'empty' } as const;
      if (decision?.action === 'draft') {
        const saved = drafts.confirm(owner, previous.revision);
        return saved ? { action: 'saved', previous, saved } as const : { action: 'empty' } as const;
      }
    }
    if (/^(?:отмена|отмени|(?:пока )?не (?:сохраняй|записывай))$/u.test(control)
      || (control === 'нет' && (!previous || decision?.action === 'draft'))) {
      if (previous) drafts.remove(owner, previous.revision);
      return { action: 'cancel', previous } as const;
    }
    return { action: 'plan', previous, draft: drafts.begin(owner, text, previous) } as const;
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith('/')) return;
    if (text.length > 4096) return void ctx.reply('Слишком длинное сообщение, разбей его на части.');
    const owner = String(ctx.from.id);
    const replied = ctx.message.reply_to_message;
    const result = takeText(ctx.update.update_id, owner, text, replied?.from?.id === ctx.me.id ? replied.message_id : undefined);
    switch (result.action) {
      case 'ignore': return;
      case 'stale': await ctx.reply('Это сообщение уже не связано с активным черновиком.'); return;
      case 'empty': await ctx.reply('Сейчас нет черновика, готового к сохранению.'); return;
      case 'cancel':
        await clearDraftKeyboard(ctx, result.previous);
        await ctx.reply(result.previous ? 'Хорошо, не сохраняю.' : 'Активного черновика нет.');
        return;
      case 'saved': await showSaved(ctx, result.previous, result.saved); return;
      case 'plan': await respond(ctx, owner, result.draft, result.previous, directSave(text));
    }
  });

  const takeButton = db.transaction((owner: string, revision: string, messageId: number | undefined, button: string) => {
    const previous = drafts.get(owner);
    if (previous?.revision !== revision || previous.messageId !== messageId) return;
    if (button === 's') {
      const saved = drafts.confirm(owner, revision);
      if (saved) return { action: 'saved', previous, saved } as const;
    } else {
      const decision = getDecision(previous);
      const choice = decision?.action === 'clarify' ? decision.choices[Number(button)] : undefined;
      if (choice) return { action: 'plan', previous, draft: drafts.begin(owner, choice, previous) } as const;
    }
  });

  bot.callbackQuery(/^draft:([0-9a-f-]{36}):(s|[0-2])$/u, async (ctx) => {
    const [, revision, button] = ctx.match;
    const owner = String(ctx.from.id);
    const result = takeButton(owner, revision, ctx.callbackQuery.message?.message_id, button);
    try {
      await ctx.answerCallbackQuery(result ? undefined : { text: 'Черновик уже изменился.' });
    } catch {
      log.warn('Could not acknowledge Telegram draft button');
    }
    if (result?.action === 'saved') await showSaved(ctx, result.previous, result.saved);
    if (result?.action === 'plan') await respond(ctx, owner, result.draft, result.previous, false);
  });
  // Never surface internal stack traces to the user.
  bot.catch((err) => {
    log.error({ err: (err as Error).message }, 'Telegram update error');
    const ctx = (err as { ctx?: { reply?: (t: string) => Promise<unknown> } }).ctx;
    return ctx?.reply?.('Не получилось обработать сообщение, попробуй ещё раз.').catch(() => undefined);
  });
  bot.start({ allowed_updates: ['message', 'callback_query'], onStart: () => log.info('Telegram polling started') })
    .catch((err) => log.error({ err }, 'Telegram bot failed'));
  return bot;
}
