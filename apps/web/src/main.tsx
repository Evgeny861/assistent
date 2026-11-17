import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Lightbulb, Plus, Search, Check, Archive, Trash2, Download } from 'lucide-react';
import './style.css';

type Entry = {
  id: string; original_text: string; title: string; kind: string;
  project: string; status: string; tags: string[]; ai_state: string; classification_source: 'gemini' | 'rules' | null; created_at: string;
  reminder_due_at?: number | null;
  reminder_time_zone?: string | null;
  reminder_status?: keyof typeof REMINDER_LABELS | null;
};

declare global {
  interface Window {
    Telegram?: { WebApp?: { initData: string; ready: () => void; expand: () => void } };
  }
}

const KINDS = ['note', 'idea', 'wish', 'task', 'event', 'purchase'] as const;
const KIND_LABELS: Record<string, string> = {
  note: 'Заметка', idea: 'Идея', wish: 'Желание', task: 'Задача', event: 'Событие', purchase: 'Покупка',
};
const STATUS_LABELS: Record<string, string> = {
  inbox: 'Входящие', active: 'В работе', done: 'Готово', archived: 'Архив',
};
const REMINDER_LABELS = {
  pending: 'Напомню', sending: 'Отправляется', sent: 'Напоминание отправлено',
  failed: 'Не удалось отправить напоминание', cancelled: 'Напоминание отменено',
};
const STATUSES = ['inbox', 'active', 'done', 'archived'] as const;

async function api(path: string, options: RequestInit = {}) {
  const headers: Record<string, string> = {
    'x-telegram-init-data': window.Telegram?.WebApp?.initData || '',
  };
  // Content-Type only with a body: Fastify rejects an empty JSON body with 400
  // (this broke DELETE, which has no body).
  if (options.body != null) headers['Content-Type'] = 'application/json';
  const r = await fetch('/api' + path, { ...options, headers: { ...headers, ...(options.headers as Record<string, string>) } });
  if (!r.ok) {
    const messages: Record<number, string> = {
      401: 'Требуется вход через Telegram',
      403: 'У этого аккаунта нет доступа к Recall',
    };
    const e = new Error(messages[r.status] ?? `Ошибка API: ${r.status}`);
    (e as Error & { status?: number }).status = r.status;
    throw e;
  }
  return r.json();
}

function Card({ x, onChanged, onDelete }: { x: Entry; onChanged: () => void; onDelete: (id: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(x.title);
  const [project, setProject] = useState(x.project);
  const [tags, setTags] = useState((x.tags || []).join(', '));
  useEffect(() => { setTitle(x.title); setProject(x.project); setTags((x.tags || []).join(', ')); }, [x.id, x.title, x.project, x.tags]);
  async function send(patch: Record<string, unknown>) {
    try { await api('/entries/' + x.id, { method: 'PATCH', body: JSON.stringify(patch) }); onChanged(); }
    catch (e) { alert(String(e)); }
  }
  const saveTitle = () => { const v = title.trim(); if (v && v !== x.title) void send({ title: v }); else setTitle(x.title); };
  const saveProject = () => { const v = project.trim() || 'Inbox'; if (v !== x.project) void send({ project: v }); else setProject(x.project); };
  const saveTags = () => {
    const arr = tags.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 8);
    const next = JSON.stringify(arr);
    if (next !== JSON.stringify(x.tags || [])) void send({ tags: arr } as Record<string, unknown>);
  };
  const reminderDate = x.reminder_due_at && x.reminder_time_zone
    ? new Intl.DateTimeFormat('ru-RU', {
      timeZone: x.reminder_time_zone, dateStyle: 'short', timeStyle: 'short',
    }).format(x.reminder_due_at) + ' (' + (x.reminder_time_zone === 'Europe/Moscow' ? 'МСК' : x.reminder_time_zone) + ')'
    : null;
  const labels = { gemini: 'Разобрано Gemini', rules: 'Разобрано по правилам' };
  return (
    <article className="entry">
      <div className="entryhead">
        <span className="tag">{x.project}</span>
        <span className={'badge ' + (x.ai_state === 'done' ? 'ok' : x.ai_state === 'failed' ? 'err' : 'wait')}>
          {x.ai_state === 'done' ? (x.classification_source ? labels[x.classification_source] : 'Разобрано') : x.ai_state === 'failed' ? 'Не разобрано' : 'Ожидает разбор'}
        </span>
        <span className="date">{new Date(x.created_at).toLocaleDateString('ru-RU')}</span>
      </div>
      <h3>{x.title}</h3>
      {x.reminder_status && reminderDate && (
        <p>🔔 {REMINDER_LABELS[x.reminder_status]} · {reminderDate}</p>
      )}
      <p>{x.original_text}</p>
      {(x.tags || []).length > 0 && (
        <div className="entrytags">{x.tags.map((t) => <span key={t} className="mini">{t}</span>)}</div>
      )}
      <div className="entryfoot">
        <span className="mini">{KIND_LABELS[x.kind] ?? x.kind}</span>
        <span className="mini">{STATUS_LABELS[x.status] ?? x.status}</span>
        <button type="button" aria-expanded={editing} aria-controls={`entry-edit-${x.id}`} onClick={() => setEditing(!editing)}>
          {editing ? 'Закрыть' : 'Редактировать'}
        </button>
        <button title="Готово" onClick={() => void send({ status: 'done' })}><Check size={16} /></button>
        <button title="Архив" onClick={() => void send({ status: 'archived' })}><Archive size={16} /></button>
        <button title="Удалить" className="danger" onClick={() => { if (confirm('Удалить запись?')) onDelete(x.id); }}>
          <Trash2 size={16} />
        </button>
      </div>
      <div id={`entry-edit-${x.id}`} hidden={!editing}>
        {editing && <div className="entryedit">
          <select value={x.kind} onChange={(e) => void send({ kind: e.target.value })} aria-label="Тип">
            {KINDS.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
          </select>
          <select value={x.status} onChange={(e) => void send({ status: e.target.value })} aria-label="Статус">
            {STATUSES.map((k) => <option key={k} value={k}>{STATUS_LABELS[k]}</option>)}
          </select>
          <input value={title} onChange={(e) => setTitle(e.target.value)} onBlur={saveTitle} placeholder="Заголовок" maxLength={180} aria-label="Заголовок" />
          <input value={project} onChange={(e) => setProject(e.target.value)} onBlur={saveProject} placeholder="Проект" maxLength={100} aria-label="Проект" />
          <input value={tags} onChange={(e) => setTags(e.target.value)} onBlur={saveTags} placeholder="Теги через запятую" aria-label="Теги" />
        </div>}
      </div>
    </article>
  );
}

function App() {
  const [items, setItems] = useState<Entry[]>([]);
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [error, setError] = useState('');
  const [authError, setAuthError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  async function refresh() {
    try {
      setItems(await api('/entries'));
      setError(''); setAuthError(false);
    }
    catch (e) {
      if ((e as Error & { status?: number }).status === 401) setAuthError(true);
      else setError(String(e));
    }
    finally { setLoading(false); }
  }
  useEffect(() => {
    window.Telegram?.WebApp?.ready();
    window.Telegram?.WebApp?.expand();
    void refresh();
  }, []);
  async function add() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try { await api('/entries', { method: 'POST', body: JSON.stringify({ text }) }); setText(''); await refresh(); }
    catch (e) { if ((e as Error & { status?: number }).status === 401) setAuthError(true); else setError(String(e)); }
    finally { setBusy(false); }
  }
  async function remove(id: string) {
    try { await api('/entries/' + id, { method: 'DELETE' }); await refresh(); }
    catch (e) { setError(String(e)); }
  }
  async function exportJson() {
    try {
      const data = await api('/entries/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ideaflow-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) { setError(String(e)); }
  }

  const filtered = items.filter((x) =>
    (filter === 'all' || x.kind === filter) &&
    (statusFilter === 'all' || x.status === statusFilter) &&
    `${x.title} ${x.original_text} ${x.project} ${(x.tags || []).join(' ')}`.toLowerCase().includes(query.toLowerCase()));

  return (
    <div className="shell">
      <header>
        <div className="brand"><span className="logo"><Lightbulb size={22} /></span><span>IdeaFlow<small>твоя вторая память</small></span></div>
        <div className="headright">
          <button className="ghost" onClick={() => void exportJson()} title="Скачать все записи в JSON"><Download size={15} /> Экспорт</button>
          <span className="version">MVP · 0.2</span>
        </div>
      </header>
      <main>
        {authError && (
          <div className="error authbanner">
            Данные недоступны: нужно авторизоваться через Telegram.
            Закройте приложение и откройте его заново через меню бота или кнопку в ответе на /start.
          </div>
        )}
        <section className="hero">
          <p className="eyebrow">ЛИЧНОЕ ПРОСТРАНСТВО</p>
          <h1>Все мысли.<br /><em>В одном месте.</em></h1>
          <p>Сохраняй идеи, желания и планы — ничего не потеряется.</p>
        </section>
        <section className="compose">
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Что пришло в голову?" maxLength={10000} />
          <div className="composebar"><span>Сначала во входящие, затем авто-разбор</span>
            <button disabled={busy || !text.trim()} onClick={() => void add()}><Plus size={17} /> Сохранить</button>
          </div>
        </section>
        <div className="stats">
          <div><b>{items.length}</b><span>Всего записей</span></div>
          <div><b>{items.filter((x) => x.status === 'active').length}</b><span>В работе</span></div>
          <div><b>{items.filter((x) => x.status === 'done').length}</b><span>Готово</span></div>
        </div>
        <section className="entries">
          <div className="sectiontitle">
            <h2>Мои записи</h2>
            <div className="search"><Search size={16} /><input placeholder="Поиск" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          </div>
          <div className="filters">{['all', ...KINDS].map((k) => (
            <button className={filter === k ? 'selected' : ''} key={k} onClick={() => setFilter(k)}>{k === 'all' ? 'Все' : KIND_LABELS[k]}</button>
          ))}</div>
          <div className="filters">{['all', ...STATUSES].map((k) => (
            <button className={statusFilter === k ? 'selected' : ''} key={k} onClick={() => setStatusFilter(k)}>{k === 'all' ? 'Любой статус' : STATUS_LABELS[k]}</button>
          ))}</div>
          {error && <div className="error">{error}</div>}
          {loading ? <div className="empty">Загрузка…</div>
            : filtered.length === 0 ? <div className="empty">Пока ничего нет. Добавь первую мысль ✨</div>
            : <div className="cards">{filtered.map((x) => <Card key={x.id} x={x} onChanged={refresh} onDelete={(id) => void remove(id)} />)}</div>}
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
