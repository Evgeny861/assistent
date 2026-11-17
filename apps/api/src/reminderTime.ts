export const defaultReminderTimeZone = 'Europe/Moscow';

export type ReminderDraft = {
  title: string;
  date?: string;
  time?: string;
  timeZone: string;
  dueAt?: number;
};

const hourMs = 3_600_000;
const dayMs = 24 * hourMs;
const minuteMs = 60_000;
const weekDays = ['воскресенье', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу'];
const months = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];
const amounts: Record<string, number> = {
  один: 1, одну: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, десять: 10,
  пятнадцать: 15, двадцать: 20, тридцать: 30,
};
const amount = '(\\d{1,5}|' + Object.keys(amounts).join('|') + ')';
const hours = 'час(?:а|ов)?';
const minutes = 'мин(?:ут[уы]?)?';
const relative = new RegExp(
  '(^|\\s)через\\s+(полчаса|полтора\\s+часа|четверть\\s+часа|(?:' + amount + '\\s+)?(' + hours + ')(?:\\s+(?:и\\s+)?' + amount + '\\s+' + minutes + ')?|(?:' + amount + '\\s+)?(' + minutes + '))(?=$|[\\s,.!?;])',
  'iu',
);
const day = new RegExp(
  '(^|\\s)(?:(?:в|на)\\s+)?(?:(следующ(?:ий|ую|ее)|эту|этот|это)\\s+)?(сегодня|послезавтра|завтра|' + weekDays.join('|') + '|среда|пятница|суббота)(?=$|[\\s,.!?;])',
  'iu',
);
const namedDate = new RegExp('(^|\\s)(\\d{1,2})\\s+(' + months.join('|') + ')(?:\\s+(20\\d{2}))?(?=$|[\\s,.!?;])', 'iu');
const numericDate = /(^|\s)(\d{1,2})[./](\d{2})(?:[./](\d{4}))?(?=$|[\s,.!?;])/u;
const clock = /(^|\s)(?:в\s+)?(\d{1,2}):(\d{2})(?:\s+(утра|дня|вечера|ночи|утром|дн[её]м|вечером|ночью))?(?=$|[\s,.!?;])/iu;
const prefixedHour = /(^|\s)в\s+(\d{1,2})(?:\s+(?:час(?:а|ов)?\s+)?(утра|дня|вечера|ночи|утром|дн[её]м|вечером|ночью)|\s+час(?:а|ов)?)?(?=$|[\s,.!?;])/iu;
const relativeDay = /(^|\s)через\s+(?:(\d{1,4})\s+)?(день|дня|дней|неделю|недели|недель)(?=$|[\s,.!?;])/iu;
const vagueTime = /(^|\s)(утром|дн[её]м|вечером|ночью|после обеда|к обеду)(?=$|[\s,.!?;])/iu;

const reminderIntent = /(^|[\s,])(?:напомни(?:те|шь|ть)?|поставь напоминание|напоминание:)(?=$|[\s,:.!?])/iu;
export function reminderRequest(text: string) {
  const match = reminderIntent.exec(text);
  if (!match) return;
  const prefix = text.slice(0, match.index);
  if (/(?:^|\s)не$/iu.test(prefix.trim())) return;
  const input = prefix + ' ' + text.slice(match.index + match[0].length);
  return input
    .replace(/^\s*(?:(?:можешь|пожалуйста|мне)(?=[\s,]|$)|[,.:])[\s,]*/iu, '')
    .replace(/^\s*мне(?=\s|$)/iu, '').trim();
}

const dateString = (date: Date) => date.toISOString().slice(0, 10);
const pad = (value: number) => String(value).padStart(2, '0');

function wallTime(timestamp: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(timestamp);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

function matchingInstants(date: string, time: string, zone: string) {
  const wallMs = Date.parse(`${date}T${time}:00Z`);
  // Sample both sides of a possible offset transition. Reject skipped or repeated wall times.
  const offsets = new Set([-dayMs, 0, dayMs].map((delta) => {
    const sample = wallMs + delta;
    const local = wallTime(sample, zone);
    return Date.parse(`${local.date}T${local.time}:00Z`) - sample;
  }));
  return [...offsets].map((offset) => wallMs - offset).filter((instant) => {
    const local = wallTime(instant, zone);
    return local.date === date && local.time === time;
  });
}

export function formatReminder(dueAt: number, timeZone: string) {
  const { date, time } = wallTime(dueAt, timeZone);
  return `${date.split('-').reverse().join('.')} в ${time} (${timeZone === defaultReminderTimeZone ? 'МСК' : timeZone})`;
}

function calendarDate(year: number, month: number, date: number) {
  const value = new Date(Date.UTC(year, month - 1, date));
  if (value.getUTCFullYear() === year && value.getUTCMonth() === month - 1 && value.getUTCDate() === date) {
    return dateString(value);
  }
}

export function planReminder(input: string, now: number, timeZone: string, previous?: ReminderDraft) {
  const today = wallTime(now, timeZone).date;
  const utcDay = Date.parse(today + 'T00:00:00Z');
  const draft: ReminderDraft = previous ? { ...previous } : { title: '', timeZone };
  let text = input.trim().replace(/^(?:(?:нет|поправка|лучше|перенеси|а|давай)[\s,:]+)+/iu, '');
  // A title correction is accepted explicitly, so numbers in the title stay intact.
  const titleEdit = /^(?:текст|задача|что напомнить)\s*:\s*(.+)$/isu.exec(text);
  let issue: string | undefined;
  let recognized = false;

  if (titleEdit) {
    draft.title = titleEdit[1].trim().slice(0, 180);
    text = '';
  }

  const remove = (match: RegExpExecArray) => {
    recognized = true;
    text = text.slice(0, match.index) + ' ' + text.slice(match.index + match[0].length);
  };

  const duration = relative.exec(text);
  if (duration) {
    const [, , phrase, h, hourUnit, m, shortMinutes, minuteUnit] = duration;
    const count = (value?: string) => value ? amounts[value.toLowerCase()] ?? Number(value) : 1;
    const special = phrase.toLowerCase().replace(/\s+/gu, ' ');
    const total = special === 'полчаса' ? 30 : special === 'полтора часа' ? 90
      : special === 'четверть часа' ? 15
        : hourUnit ? count(h) * 60 + (m ? count(m) : 0) : minuteUnit ? count(shortMinutes) : 0;
    remove(duration);
    if (total > 0) {
      const dueAt = now + total * minuteMs;
      Object.assign(draft, wallTime(dueAt, timeZone), { dueAt });
    } else {
      draft.time = undefined;
      issue = 'Через сколько минут или часов напомнить?';
    }
  } else {
    const dayMatch = day.exec(text);
    const dateMatch = namedDate.exec(text) ?? numericDate.exec(text);
    const daysFromNow = relativeDay.exec(text);
    if (dayMatch || dateMatch || daysFromNow) {
      draft.dueAt = undefined;
      if (dayMatch) {
        const name = dayMatch[3].toLowerCase();
        const normalizedDay = ({ среда: 'среду', пятница: 'пятницу', суббота: 'субботу' } as Record<string, string>)[name] ?? name;
        const weekday = weekDays.indexOf(normalizedDay);
        let days = name === 'завтра' ? 1 : name === 'послезавтра' ? 2 : 0;
        if (weekday >= 0) {
          const current = new Date(utcDay).getUTCDay();
          days = (weekday - current + 7) % 7;
          if (dayMatch[2]?.toLowerCase().startsWith('следующ')) {
            const mondayOffset = (current + 6) % 7;
            days = 7 - mondayOffset + (weekday + 6) % 7;
          }
        }
        draft.date = dateString(new Date(utcDay + days * dayMs));
        remove(dayMatch);
      } else if (daysFromNow) {
        const days = Number(daysFromNow[2] ?? 1) * (daysFromNow[3].toLowerCase().startsWith('недел') ? 7 : 1);
        draft.date = dateString(new Date(utcDay + days * dayMs));
        remove(daysFromNow);
      } else if (dateMatch) {
        const month = months.indexOf(dateMatch[3].toLowerCase()) + 1 || Number(dateMatch[3]);
        const year = Number(dateMatch[4] ?? today.slice(0, 4));
        draft.date = calendarDate(year, month, Number(dateMatch[2]));
        if (!draft.date) issue = 'Такой даты нет. На какой день поставить напоминание?';
        remove(dateMatch);
      }
    }

    const timeMatch = clock.exec(text);
    const hourMatch = timeMatch ? null : prefixedHour.exec(text);
    const bareHour = previous && /^\s*(\d{1,2})\s*$/u.exec(text);
    if (timeMatch || hourMatch || bareHour) {
      draft.dueAt = undefined;
      const match = timeMatch ?? hourMatch ?? bareHour!;
      const period = (timeMatch?.[4] ?? hourMatch?.[3])?.toLowerCase();
      const rawHour = Number(timeMatch?.[2] ?? hourMatch?.[2] ?? bareHour?.[1]);
      const mins = Number(timeMatch?.[3] ?? 0);
      let hour = rawHour;
      if (period && hour >= 1 && hour <= 12) {
        if (/^(?:д|веч)/u.test(period)) hour = hour % 12 + 12;
        if (hour === 12 && /^ноч/u.test(period)) hour = 0;
      }
      if (hour > 23 || mins > 59) {
        draft.time = undefined;
        issue ??= 'Укажи время в формате ЧЧ:ММ, например 19:30.';
      } else if (!timeMatch && !period && hour >= 1 && hour <= 12) {
        draft.time = undefined;
        issue ??= `Ты имеешь в виду ${pad(hour % 12)}:00 или ${pad(hour % 12 + 12)}:00?`;
      } else {
        draft.time = `${pad(hour)}:${pad(mins)}`;
      }
      remove(match);
    } else {
      const vague = vagueTime.exec(text);
      if (vague) {
        draft.time = undefined;
        draft.dueAt = undefined;
        remove(vague);
      }
    }
  }

  const rest = text.trim().replace(/^[\s,.:;!?-]+|[\s,.:;!?-]+$/gu, '').replace(/\s+/gu, ' ');
  const extraSchedule = recognized && (
    relative.test(rest) || relativeDay.test(rest) || day.test(rest) || clock.test(rest)
    || prefixedHour.test(rest) || namedDate.test(rest) || numericDate.test(rest)
    || /^(?:или|либо)(?=\s|$)/iu.test(rest)
  );
  if (extraSchedule) {
    draft.date = draft.time = undefined;
    draft.dueAt = undefined;
    issue = 'Укажи один вариант даты и времени, например «завтра в 19:30».';
  } else if (rest && (!draft.title || recognized)) {
    draft.title = rest.slice(0, 180);
  }

  if (draft.date && !draft.dueAt && draft.time) {
    const instants = matchingInstants(draft.date, draft.time, timeZone);
    if (instants.length === 1) draft.dueAt = instants[0];
    else issue ??= 'Из-за перевода часов это время неоднозначно или пропущено. Укажи другое время.';
  }
  if (draft.dueAt != null && draft.dueAt <= now) {
    draft.dueAt = undefined;
    issue ??= 'Это время уже прошло. На когда перенести напоминание?';
  }

  if (previous?.title && !recognized && !titleEdit && !/^(?:да|подтверждаю)$/iu.test(text)) {
    issue ??= 'Укажи дату или время, например «завтра в 19:30». Чтобы исправить задачу, напиши «текст: …».';
  }
  const question = issue ?? (!draft.title ? 'О чём напомнить?'
    : !draft.date && !draft.time ? 'В какой день и во сколько напомнить?'
      : !draft.date ? 'В какой день напомнить?'
        : !draft.time ? 'Во сколько напомнить? Например, 19:30.'
          : undefined);
  return { draft, question };
}
