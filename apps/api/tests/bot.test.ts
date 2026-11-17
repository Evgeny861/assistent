import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real grammY Bot + real handlers + real SQLite, but the Telegram API is mocked:
// the bot's ApiClient points at a local HTTP server instead of api.telegram.org.
const BOT_TOKEN = '123456:TEST-TOKEN-ONLY-FOR-BOT-E2E';

function makeUpdate(partial: Record<string, unknown>): Record<string, unknown> {
  return { update_id: 1, ...partial };
}

function privateText(updateId: number, userId: number, text: string, replyTo?: number): Record<string, unknown> {
  return makeUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false, first_name: 'User' },
      chat: { id: userId, type: 'private', first_name: 'User' },
      date: Math.floor(Date.now() / 1000),
      text,
      ...(replyTo ? { reply_to_message: botMessage(replyTo, userId) } : {}),
    },
  });
}

function botMessage(messageId: number, userId: number) {
  return {
    message_id: messageId,
    from: { id: 424242, is_bot: true, first_name: 'TestBot' },
    chat: { id: userId, type: 'private', first_name: 'User' },
    date: Math.floor(Date.now() / 1000),
    text: 'Предложение',
  };
}

function press(updateId: number, userId: number, messageId: number, data: string) {
  return makeUpdate({
    update_id: updateId,
    callback_query: {
      id: String(updateId),
      from: { id: userId, is_bot: false, first_name: 'User' },
      chat_instance: String(userId),
      message: botMessage(messageId, userId),
      data,
    },
  });
}

function groupText(updateId: number, userId: number, text: string): Record<string, unknown> {
  return makeUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false, first_name: 'User' },
      chat: { id: 999999, type: 'group', title: 'Group' },
      date: Math.floor(Date.now() / 1000),
      text,
    },
  });
}

function commandUpdate(updateId: number, userId: number, command: string): Record<string, unknown> {
  // Real Telegram always sends a bot_command entity for command messages;
  // grammY's command filter requires it.
  return makeUpdate({
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: userId, is_bot: false, first_name: 'User' },
      chat: { id: userId, type: 'private', first_name: 'User' },
      date: Math.floor(Date.now() / 1000),
      text: '/' + command,
      entities: [{ type: 'bot_command', offset: 0, length: 1 + command.length }],
    },
  });
}

type TelegramRequest = {
  method: string;
  text?: string;
  callback_query_id?: string;
  message_id: number;
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
};

async function waitFor(check: () => boolean, description: string) {
  const deadline = Date.now() + 5000;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(check(), description);
}

test('Telegram drafts: discuss, correct, confirm once, cancel, and reject obsolete buttons', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ideaflow-bot-test-'));
  process.env.DB_PATH = join(dir, 'bot.db');
  process.env.GEMINI_API_KEY = 'test-gemini-key';
  process.env.TELEGRAM_ALLOWED_USER_IDS = '111,333';
  const { db, closeDb } = await import('../src/db.js');
  const { startTelegramBot } = await import('../src/bot.js');
  process.env.REMINDER_TIME_ZONE = 'Europe/Moscow';
  const { startReminderDelivery } = await import('../src/reminders.js');
  const realFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith('https://generativelanguage.googleapis.com/')) return realFetch(input, init);
    const body = JSON.parse(String(init?.body));
    const data = JSON.parse(body.contents[0].parts[0].text.split('\n').at(-1));
    const latest = data.turns.at(-1).text;
    const payload = latest === 'Мстители в кино'
      ? { action: 'clarify', question: 'Хочешь сходить или узнать дату?', choices: ['Хочу сходить', 'Узнать дату'] }
      : latest === 'Узнать дату'
        ? { action: 'reply', text: 'Сейчас у меня нет доступа к поиску.' }
        : latest === 'Хочу сходить'
          ? { action: 'clarify', question: 'Добавить на эти выходные?', choices: ['Да', 'Нет'] }
          : {
          action: 'draft',
          classification: {
            title: latest.includes('поправка') ? 'Подключить Claude' : latest === 'да' ? 'Сходить на Мстителей в выходные' : latest,
            kind: latest.includes('поправка') ? 'task' : 'idea',
            project: latest.includes('Management OS') ? 'Management OS' : undefined,
            tags: ['recall'],
            confidence: 0.9,
          },
        };
    if (latest === 'Задача: офлайн') return Promise.resolve(new Response(null, { status: 401 }));
    const decision = { decision: payload };
    return Promise.resolve(Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(decision) }] } }] }));
  });

  const queue: Record<string, unknown>[] = [];
  const calls: TelegramRequest[] = [];
  let messageId = 1000;
  let rejectNextReminder = false;
  const mock = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += String(d)));
    req.on('end', () => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const method = url.pathname.replace(/^\/bot[^/]+\//, '');
      const reply = (payload: unknown) => {
        const body = Buffer.from(JSON.stringify(payload));
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length });
        res.end(body);
      };
      if (method === 'getMe') {
        reply({ ok: true, result: { id: 424242, is_bot: true, first_name: 'TestBot', username: 'testbot' } });
      } else if (method === 'getUpdates') {
        reply({ ok: true, result: queue.splice(0) });
      } else {
        const args = body ? JSON.parse(body) : {};
        if (method === 'sendMessage') args.message_id = ++messageId;
        calls.push({ method, ...args });
        if (method === 'sendMessage' && args.text?.startsWith('🔔') && rejectNextReminder) {
          rejectNextReminder = false;
          return reply({ ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 45 } });
        }
        reply({ ok: true, result: method === 'answerCallbackQuery' ? true : botMessage(args.message_id, args.chat_id) });
      }
    });
  });
  await new Promise<void>((r) => mock.listen(0, '127.0.0.1', () => r()));
  const mockPort = (mock.address() as { port: number }).port;

  const errors: unknown[] = [];
  const log = { info: () => {}, warn: () => {}, error: (error: unknown) => errors.push(error) };
  const bot = startTelegramBot({ token: BOT_TOKEN, db, log, apiBaseURL: `http://127.0.0.1:${mockPort}` });
  let worker: ReturnType<typeof startReminderDelivery> | undefined;
  t.after(async () => {
    await worker?.stop();
    await bot.stop();
    await new Promise<void>((r) => mock.close(() => r()));
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  });

  const entries = () => db.prepare('SELECT original_text, title, kind, project, ai_state, classification_source FROM entries ORDER BY rowid').all();
  const draftMessages = () => calls.filter((call) => call.method === 'sendMessage' && call.reply_markup?.inline_keyboard[0]?.[0]?.callback_data);
  const menu = (message: TelegramRequest) => message.reply_markup!.inline_keyboard.flat();
  const cleared = (id: number) => calls.some((call) => call.method === 'editMessageReplyMarkup'
    && call.message_id === id && call.reply_markup?.inline_keyboard.length === 0);

  const original = 'Сделать Claude ассистентом для Management OS';
  queue.push(privateText(1, 111, original));
  await waitFor(() => draftMessages().length === 1, 'a clear idea gets a draft');
  const first = draftMessages()[0];
  assert.equal(menu(first)[0].text, '✓ Сохранить');
  assert.match(first.text!, /Создам проект «Management OS»/);
  assert.deepEqual(entries(), []);

  // A correction hides the old keyboard and offers a new revision. Neither
  // another account nor a stale callback or reply can confirm this draft.
  queue.push(privateText(2, 111, 'поправка: это задача для Management OS'));
  await waitFor(() => draftMessages().length === 2, 'correction gets a new draft');
  assert.ok(cleared(first.message_id));
  const revised = draftMessages()[1];
  assert.match(revised.text!, /Задача: Подключить Claude/);
  assert.notEqual(menu(revised)[0].callback_data, menu(first)[0].callback_data);
  queue.push(
    press(3, 333, revised.message_id, menu(revised)[0].callback_data),
    press(4, 111, first.message_id, menu(first)[0].callback_data),
    privateText(5, 111, 'да', first.message_id),
  );
  await waitFor(() => calls.some((call) => call.text?.includes('не связано')), 'stale text reply rejected');
  assert.deepEqual(entries(), []);

  queue.push(
    press(6, 111, revised.message_id, menu(revised)[0].callback_data),
    press(7, 111, revised.message_id, menu(revised)[0].callback_data),
    privateText(2, 111, 'поправка: это задача для Management OS'),
  );
  await waitFor(() => calls.some((call) => call.callback_query_id === '7'), 'duplicate callback processed');
  assert.deepEqual(entries(), [{
    original_text: original, title: 'Подключить Claude', kind: 'task',
    project: 'Management OS', ai_state: 'done', classification_source: 'gemini',
  }]);
  const confirmation = calls.find((call) => call.method === 'editMessageText' && call.message_id === revised.message_id);
  assert.match(confirmation?.text ?? '', /Сохранено в «Management OS»/);
  assert.deepEqual(confirmation?.reply_markup?.inline_keyboard, []);

  queue.push(privateText(8, 111, 'Мстители в кино'));
  await waitFor(() => draftMessages().length === 3, 'ambiguous phrase gets a question');
  const clarification = draftMessages()[2];
  assert.deepEqual(menu(clarification).map(({ text }) => text), ['Хочу сходить', 'Узнать дату']);
  queue.push(press(9, 111, clarification.message_id, menu(clarification)[1].callback_data));
  await waitFor(() => calls.some((call) => call.text?.includes('нет доступа к поиску')), 'informational branch replies');
  assert.ok(cleared(clarification.message_id));
  assert.equal(entries().length, 1);

  queue.push(privateText(10, 111, 'Мстители в кино'));
  await waitFor(() => draftMessages().length === 4, 'second clarification');
  const nextQuestion = draftMessages()[3];
  queue.push(privateText(11, 111, 'Хочу сходить'));
  await waitFor(() => draftMessages().length === 5, 'ordinary text can answer a question');
  assert.ok(cleared(nextQuestion.message_id));
  const yesNo = draftMessages()[4];
  queue.push(privateText(12, 111, 'да'));
  await waitFor(() => draftMessages().length === 6, 'yes can answer a clarification without saving');
  assert.ok(cleared(yesNo.message_id));
  assert.equal(entries().length, 1);
  const canceled = draftMessages()[5];
  queue.push(privateText(13, 111, 'пока не сохраняй'), press(14, 111, canceled.message_id, menu(canceled)[0].callback_data));
  await waitFor(() => calls.some((call) => call.callback_query_id === '14'), 'button after cancellation handled');
  assert.ok(cleared(canceled.message_id));
  assert.equal(entries().length, 1);

  queue.push(privateText(15, 111, 'Запиши идею для Management OS'));
  await waitFor(() => entries().length === 2, 'explicit save request saves directly');
  assert.equal(draftMessages().length, 6);

  queue.push(privateText(16, 111, 'Задача: офлайн'));
  await waitFor(() => draftMessages().length === 7, 'provider outage still permits proposing a draft');
  // Verify the text confirmation transaction rolls back both the entry and update claim.
  db.exec(`CREATE TRIGGER fail_capture BEFORE INSERT ON entries
    WHEN NEW.original_text = 'Задача: офлайн' BEGIN SELECT RAISE(ABORT, 'test write failure'); END`);
  queue.push(privateText(17, 111, 'да'));
  await waitFor(() => calls.some((call) => call.text?.includes('Не получилось обработать')), 'save error is reported');
  assert.equal(db.prepare('SELECT 1 FROM tg_updates WHERE update_id = 17').get(), undefined);
  db.exec('DROP TRIGGER fail_capture');
  queue.push(privateText(17, 111, 'да'));
  await waitFor(() => entries().length === 3, 'text confirmation can be retried after rollback');
  assert.deepEqual(entries().at(-1), {
    original_text: 'Задача: офлайн', title: 'офлайн', kind: 'task', project: 'Inbox',
    ai_state: 'done', classification_source: 'rules',
  });

  queue.push(groupText(18, 111, 'кино в группе'), privateText(19, 222, 'Чужая заметка'), commandUpdate(20, 111, 'start'));
  await waitFor(() => calls.some((call) => call.text?.startsWith('Пришли мысль')), '/start replies');
  assert.equal(entries().length, 3);
  assert.deepEqual(db.prepare('SELECT owner_id FROM telegram_drafts').all(), []);
  assert.equal(errors.length, 1, 'only the injected storage error is expected');

  const scheduled = () => db.prepare('SELECT entry_id, status, due_at, next_attempt_at, attempts FROM reminders ORDER BY rowid').all() as {
    entry_id: string; status: string; due_at: number; next_attempt_at: number; attempts: number;
  }[];
  const sent = () => calls.filter((call) => call.method === 'sendMessage' && call.text?.startsWith('🔔'));
  const nextDraft = async (index: number) => {
    await waitFor(() => draftMessages().length > index, 'bot sends a reminder draft');
    return draftMessages()[index];
  };

  queue.push(privateText(21, 111, 'Напомни завтра вечером забрать заказ'));
  const asksTime = await nextDraft(7);
  assert.match(asksTime.text!, /Во сколько/);
  assert.deepEqual(scheduled(), []);
  queue.push(privateText(22, 111, '19:30'));
  const proposal = await nextDraft(8);
  assert.match(proposal.text!, /Напомнить \d{2}\.\d{2}\.\d{4} в 19:30 \(МСК\)\?\nзабрать заказ/u);
  queue.push(privateText(23, 111, 'нет, лучше в 20:00'));
  const revision = await nextDraft(9);
  assert.ok(cleared(proposal.message_id));
  assert.match(revision.text!, /20:00 \(МСК\)\?\nзабрать заказ/u);
  queue.push(
    press(24, 111, proposal.message_id, menu(proposal)[0].callback_data),
    press(25, 333, revision.message_id, menu(revision)[0].callback_data),
    press(26, 111, revision.message_id, menu(revision)[0].callback_data),
    press(27, 111, revision.message_id, menu(revision)[0].callback_data),
  );
  await waitFor(() => calls.some((call) => call.callback_query_id === '27'), 'old, other-owner, and repeated callbacks handled');
  assert.equal(scheduled().length, 1);
  assert.equal(entries().at(-1)?.title, 'забрать заказ');
  const savedReminder = calls.find((call) => call.method === 'editMessageText' && call.message_id === revision.message_id);
  assert.match(savedReminder?.text ?? '', /^✓ Напомню.*20:00/u);
  assert.deepEqual(savedReminder?.reply_markup?.inline_keyboard, []);

  queue.push(privateText(28, 111, 'через 3 часа напомни купить билеты на новый год'));
  const relativeProposal = await nextDraft(10);
  assert.match(relativeProposal.text!, /купить билеты на новый год/u);
  queue.push(privateText(29, 111, 'да'), commandUpdate(30, 111, 'reminders'));
  const list = await nextDraft(11);
  assert.match(list.text!, /купить билеты на новый год/u);
  const [firstReminder, secondReminder] = scheduled();
  assert.ok(secondReminder.due_at > Date.now() + 179 * 60_000);
  const cancel = menu(list).find((button) => button.callback_data.includes(secondReminder.entry_id))!;
  queue.push(press(31, 111, list.message_id, cancel.callback_data));
  await waitFor(() => scheduled()[1].status === 'cancelled', 'owner cancels a pending reminder in the list');

  const restartWorker = () => startReminderDelivery(db, bot.api, { error: () => {} }, 20);
  const forceDue = () => db.prepare('UPDATE reminders SET next_attempt_at = ? WHERE entry_id = ?').run(Date.now() - 1, firstReminder.entry_id);
  rejectNextReminder = true;
  forceDue();
  worker = restartWorker();
  await waitFor(() => scheduled()[0].status === 'pending' && scheduled()[0].attempts === 1, '429 reschedules persisted delivery');
  assert.ok(scheduled()[0].next_attempt_at >= Date.now() + 44_000);
  await worker.stop();

  forceDue();
  worker = restartWorker();
  await waitFor(() => scheduled()[0].status === 'sent', 'worker start picks up a persisted due reminder');
  assert.equal(sent().length, 2);
  const delivered = sent().at(-1)!;
  assert.match(delivered.text!, /забрать заказ/u);
  assert.deepEqual(menu(delivered).map(({ text }) => text), ['✓ Готово', 'Через 10 минут']);
  queue.push(
    press(32, 111, delivered.message_id, menu(delivered)[1].callback_data),
    press(33, 111, delivered.message_id, menu(delivered)[1].callback_data),
  );
  await waitFor(() => calls.some((call) => call.callback_query_id === '33'), 'old button cannot snooze twice');
  assert.equal(scheduled()[0].status, 'pending');
  assert.ok(scheduled()[0].due_at > Date.now() + 9 * 60_000);
  assert.equal(sent().length, 2);
  const archive = db.prepare("UPDATE entries SET status = 'archived' WHERE id = ?");
  archive.run(firstReminder.entry_id);
  assert.equal(scheduled()[0].status, 'cancelled');
  db.prepare('DELETE FROM entries WHERE id = ?').run(firstReminder.entry_id);
  assert.equal(scheduled().length, 1);
});


test('reminder time planning preserves local dates and asks about missing or ambiguous times', async () => {
  const { formatReminder, planReminder, reminderRequest } = await import('../src/reminderTime.js');
  const zone = 'Europe/Moscow';
  const now = Date.parse('2026-11-17T14:03:27Z');
  const input = reminderRequest('через 3 часа напомни купить билеты на новый год')!;
  const relative = planReminder(input, now, zone);
  assert.equal(relative.question, undefined);
  assert.equal(relative.draft.title, 'купить билеты на новый год');
  assert.equal(relative.draft.dueAt, Date.parse('2026-11-17T17:03:27Z'));
  assert.equal(formatReminder(relative.draft.dueAt!, zone), '17.11.2026 в 20:03 (МСК)');
  assert.equal(planReminder('через час 10 минут проверить тесты', now, zone).draft.dueAt, now + 70 * 60_000);
  assert.equal(planReminder('завтра в 7 вечера купить билеты', now, zone).draft.time, '19:00');
  assert.match(planReminder('завтра в 7 купить билеты', now, zone).question!, /07:00 или 19:00/u);
  const timeFirst = planReminder('купить билеты в 19:00', now, zone);
  assert.match(timeFirst.question!, /В какой день/u);
  assert.equal(planReminder('завтра', now, zone, timeFirst.draft).draft.dueAt, Date.parse('2026-11-18T16:00Z'));
  assert.match(planReminder('сегодня в 16:00 купить билеты', now, zone).question!, /уже прошло/u);
  assert.match(planReminder('31.11 в 10:00 купить билеты', now, zone).question!, /Такой даты нет/u);
  assert.match(planReminder('купить билеты сегодня или завтра в 19:00', now, zone).question!, /один вариант/u);
  const dst = planReminder('25.10.2026 в 02:30 позвонить', Date.parse('2026-10-23T12:00Z'), 'Europe/Amsterdam');
  assert.match(dst.question!, /перевода часов/u);
  assert.equal(dst.draft.dueAt, undefined);
});
