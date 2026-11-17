import { Bot, Context, InlineKeyboard } from 'grammy';
import type { Database } from 'better-sqlite3';
import { directSave, planConversation } from './conversation.js';
import { getExistingProjects, projectAllowlist } from './classifier.js';
import { getDecision, TelegramDraft, telegramDrafts } from './telegramDrafts.js';
import type { Entry } from './db.js';
import { isTelegramUserAllowed } from './auth.js';
import { defaultReminderTimeZone, formatReminder, planReminder, reminderRequest } from './reminderTime.js';
import { reminders } from './reminders.js';

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
  const scheduled = reminders(db);
  let reminderTimeZone = process.env.REMINDER_TIME_ZONE || defaultReminderTimeZone;
  try {
    new Intl.DateTimeFormat('ru', { timeZone: reminderTimeZone });
  } catch {
    log.warn('Invalid REMINDER_TIME_ZONE, using Europe/Moscow');
    reminderTimeZone = defaultReminderTimeZone;
  }
  const kindLabels = {
    note: 'Заметка', idea: 'Идея', wish: 'Желание', task: 'Задача', event: 'Событие', purchase: 'Покупка',
  };
  bot.command('start', (ctx) =>
    ctx.reply('Пришли мысль. Я предложу, как её записать, или задам вопрос. Можно поправить меня сообщением или нажать «✓ Сохранить».', miniAppButton));
  bot.command('help', (ctx) =>
    ctx.reply('Уточняй мысль обычным текстом. Чтобы сохранить, нажми «✓ Сохранить» или ответь «да». «Пока не сохраняй» отменяет черновик. Готовые записи доступны в приложении. Для напоминания напиши «Напомни завтра в 19:30 купить билеты». Список — /reminders.', miniAppButton));

  function reminderList(owner: string) {
    const list = scheduled.active(owner);
    const keyboard = new InlineKeyboard();
    const lines = list.slice(0, 10).map((item, index) => {
      const order = index + 1;
      if (item.status !== 'sending') keyboard.text(`Отменить №${order}`, `rem:${item.entry_id}:c`).row();
      const state = item.status === 'failed' ? ' · не доставлено'
        : item.status === 'sending' ? ' · отправляется'
          : item.attempts > 0 ? ' · ожидает повторной отправки' : '';
      return `${order}. ${item.title} — ${formatReminder(item.due_at, item.time_zone)}${state}`;
    });
    if (list.length > 10) lines.push('Показаны ближайшие 10 напоминаний.');
    return { text: lines.join('\n') || 'Активных напоминаний нет.', reply_markup: keyboard };
  }

  bot.command('reminders', async (ctx) => {
    const { text, reply_markup } = reminderList(String(ctx.from!.id));
    await ctx.reply(text, { reply_markup });
  });

  async function clearKeyboard(ctx: Context, messageId: number | null | undefined) {
    if (messageId == null || !ctx.chat) return;
    try { await ctx.api.editMessageReplyMarkup(ctx.chat.id, messageId, { reply_markup: { inline_keyboard: [] } }); }
    catch { log.warn('Could not clear Telegram draft keyboard'); }
  }

  async function clearDraftKeyboard(ctx: Context, draft?: TelegramDraft) {
    const decision = draft && getDecision(draft);
    if (draft?.state.reminder || decision?.action === 'draft' || (decision?.action === 'clarify' && decision.choices.length)) {
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

  async function showReminderResult(
    ctx: Context,
    draft: TelegramDraft,
    result: NonNullable<ReturnType<typeof drafts.confirmReminder>>,
  ) {
    const text = result.expired
      ? 'Это время уже прошло. На когда перенести напоминание?'
      : `✓ Напомню ${formatReminder(result.dueAt, result.timeZone)}
${result.title}`;
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

  async function showReminderDraft(ctx: Context, owner: string, draft: TelegramDraft, previous?: TelegramDraft) {
    await clearDraftKeyboard(ctx, previous);
    const reminder = draft.state.reminder!;
    const keyboard = new InlineKeyboard();
    const callback = `remdraft:${draft.revision}`;
    if (reminder.question?.startsWith('В какой день') && !reminder.draft.date) {
      keyboard.text('Сегодня', `${callback}:t`).text('Завтра', `${callback}:m`).row();
    } else if (!reminder.question) {
      keyboard.text('✓ Подтвердить', `${callback}:s`);
    }
    keyboard.text('Отмена', `${callback}:c`);
    const text = reminder.question
      ?? `Напомнить ${formatReminder(reminder.draft.dueAt!, reminder.draft.timeZone)}?
${reminder.draft.title}`;
    const message = await ctx.reply(text, { reply_markup: keyboard });
    if (!drafts.attach(owner, draft.revision, message.message_id)) {
      await clearKeyboard(ctx, message.message_id);
    }
  }

  function beginReminder(owner: string, text: string, previous: TelegramDraft | undefined, input: string, now: number) {
    const draft = drafts.begin(owner, text, previous, now);
    const existing = previous?.state.reminder?.draft;
    draft.state.source = previous?.state.source;
    draft.state.reminder = planReminder(input, now, existing?.timeZone ?? reminderTimeZone, existing);
    drafts.update(owner, draft.revision, draft.state);
    return draft;
  }

  async function respond(ctx: Context, owner: string, draft: TelegramDraft, previous: TelegramDraft | undefined, saveDirectly: boolean) {
    await clearDraftKeyboard(ctx, previous);
    const projects = [...new Set([...getExistingProjects(db, owner), ...projectAllowlist])];
    const state = await planConversation(draft.state, projects, reminderTimeZone);
    const decision = state.turns.at(-1)?.decision;
    if (!decision || !drafts.update(owner, draft.revision, state)) return;
    if (state.reminder) {
      await showReminderDraft(ctx, owner, { ...draft, state });
      return;
    }
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
    } else if (decision.action === 'reply') {
      text = decision.text;
    } else {
      return;
    }
    const hasKeyboard = keyboard.inline_keyboard.some((row) => row.length);
    const message = await ctx.reply(text, hasKeyboard ? { reply_markup: keyboard } : undefined);
    if (!drafts.attach(owner, draft.revision, message.message_id) && hasKeyboard) {
      await clearKeyboard(ctx, message.message_id);
    }
  }

  const takeText = db.transaction((updateId: number, owner: string, text: string, chatId: number, now: number, replyingTo?: number) => {
    if (!drafts.claim(updateId)) return { action: 'ignore' } as const;
    const previous = drafts.get(owner);
    if (replyingTo != null && replyingTo !== previous?.messageId) return { action: 'stale' } as const;
    const control = text.toLowerCase().replace(/[.!]+$/u, '').trim();
    const decision = previous && getDecision(previous);
    if (/^(?:да(?:,?\s+(?:запиши|сохрани))?|подтверждаю|сохрани|запиши)$/u.test(control)) {
      if (!previous) return { action: 'empty' } as const;
      if (previous.state.reminder) {
        const result = drafts.confirmReminder(owner, previous.revision, chatId);
        if (result) return { action: 'reminder-result', previous, result } as const;
        return { action: 'reminder-question', question: previous.state.reminder.question } as const;
      }
      if (decision?.action === 'draft') {
        const saved = drafts.confirm(owner, previous.revision);
        return saved ? { action: 'saved', previous, saved } as const : { action: 'empty' } as const;
      }
    }
    if (/^(?:отмена|отмени|(?:пока )?не (?:сохраняй|записывай|напоминай))$/u.test(control)
      || (control === 'нет' && (!previous || decision?.action === 'draft' || previous.state.reminder))) {
      if (previous) drafts.remove(owner, previous.revision);
      return { action: 'cancel', previous } as const;
    }
    const request = directSave(text) ? undefined : reminderRequest(text);
    if (request !== undefined) {
      return { action: 'reminder', previous, draft: beginReminder(owner, text, undefined, request, now) } as const;
    }
    if (previous?.state.reminder && !directSave(text)) {
      return { action: 'reminder', previous, draft: beginReminder(owner, text, previous, text, now) } as const;
    }
    return { action: 'plan', previous, draft: drafts.begin(owner, text, previous?.state.reminder ? undefined : previous, now) } as const;
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith('/')) return;
    if (text.length > 4096) return void ctx.reply('Слишком длинное сообщение, разбей его на части.');
    const owner = String(ctx.from.id);
    const replied = ctx.message.reply_to_message;
    const result = takeText(ctx.update.update_id, owner, text, ctx.chat.id, ctx.message.date * 1000, replied?.from?.id === ctx.me.id ? replied.message_id : undefined);
    switch (result.action) {
      case 'ignore': return;
      case 'stale': await ctx.reply('Это сообщение уже не связано с активным черновиком.'); return;
      case 'empty': await ctx.reply('Сейчас нет черновика, готового к сохранению.'); return;
      case 'cancel':
        await clearDraftKeyboard(ctx, result.previous);
        await ctx.reply(result.previous ? 'Хорошо, не сохраняю.' : 'Активного черновика нет.');
        return;
      case 'saved': await showSaved(ctx, result.previous, result.saved); return;
      case 'reminder': await showReminderDraft(ctx, owner, result.draft, result.previous); return;
      case 'reminder-result': await showReminderResult(ctx, result.previous, result.result); return;
      case 'reminder-question':
        await ctx.reply(result.question ?? 'Укажи дату и время напоминания.');
        return;
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
  const takeReminderButton = db.transaction((owner: string, revision: string, messageId: number | undefined, button: string, chatId: number) => {
    const previous = drafts.get(owner);
    if (previous?.revision !== revision || previous.messageId !== messageId || !previous.state.reminder) return;
    if (button === 'c') {
      drafts.remove(owner, revision);
      return { action: 'cancel', previous } as const;
    }
    if (button === 's') {
      const result = drafts.confirmReminder(owner, revision, chatId);
      if (result) return { action: 'confirm', previous, result } as const;
      return;
    }
    if (!previous.state.reminder.question?.startsWith('В какой день') || previous.state.reminder.draft.date) return;
    const choice = button === 't' ? 'сегодня' : 'завтра';
    return { action: 'plan', previous, draft: beginReminder(owner, choice, previous, choice, Date.now()) } as const;
  });

  bot.callbackQuery(/^remdraft:([0-9a-f-]{36}):(s|c|t|m)$/u, async (ctx) => {
    if (!ctx.chat) return;
    const [, revision, button] = ctx.match;
    const owner = String(ctx.from.id);
    const result = takeReminderButton(owner, revision, ctx.callbackQuery.message?.message_id, button, ctx.chat.id);
    await ctx.answerCallbackQuery(result ? undefined : { text: 'Черновик уже изменился.' })
      .catch(() => log.warn('Could not acknowledge reminder draft button'));
    if (result?.action === 'confirm') await showReminderResult(ctx, result.previous, result.result);
    if (result?.action === 'plan') await showReminderDraft(ctx, owner, result.draft, result.previous);
    if (result?.action === 'cancel') {
      await clearDraftKeyboard(ctx, result.previous);
      await ctx.reply('Хорошо, не ставлю напоминание.');
    }
  });

  bot.callbackQuery(/^rem:([0-9a-f-]{36}):(c|d|z)$/u, async (ctx) => {
    const [, id, button] = ctx.match;
    const owner = String(ctx.from.id);
    const messageId = ctx.callbackQuery.message?.message_id;
    if (messageId == null) return;
    let text: string | undefined;
    if (button === 'c' && scheduled.cancel(id, owner)) text = 'Напоминание отменено.';
    if (button === 'd' && scheduled.done(id, owner, messageId)) text = 'Задача выполнена.';
    if (button === 'z') {
      const snoozed = scheduled.snooze(id, owner, messageId);
      if (snoozed) text = `Напомню ${formatReminder(snoozed.dueAt, snoozed.timeZone)}.`;
    }
    await ctx.answerCallbackQuery({ text: text ?? 'Напоминание уже изменилось.' })
      .catch(() => log.warn('Could not acknowledge reminder button'));
    if (!text) return;
    if (button === 'c') {
      const list = reminderList(owner);
      await ctx.editMessageText(list.text, { reply_markup: list.reply_markup })
        .catch(() => log.warn('Could not refresh Telegram reminder list'));
    } else {
      await clearKeyboard(ctx, messageId);
    }
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
