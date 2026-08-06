'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface CommandResponse {
  batchId: string | null;
  reply: string;
  rejected: { reason: string }[];
  needsTime: { taskId: string; title: string; question: string }[];
  week: unknown;
}

interface Props {
  today: string;
  onResult: (response: CommandResponse) => void;
}

const DRAFT_KEY = 'command-draft';

export function CommandBar({ today, onResult }: Props) {
  const router = useRouter();
  const [text, setText] = useState(() =>
    typeof window === 'undefined' ? '' : (localStorage.getItem(DRAFT_KEY) ?? ''),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // Операции, выброшенные проверкой. Показать их обязательно: ответ модели
  // о них не знает и бодро отрапортует об успехе, которого не было.
  const [rejected, setRejected] = useState<{ reason: string }[]>([]);
  // Ответ модели, когда пачки не вышло. Промпт прямо велит ей в таком случае
  // объяснить причину в reply («такой задачи нет»), а показать его больше
  // негде: плашка отмены появляется только при непустом batchId, и rejected
  // тут тоже пуст — отбраковывать было нечего.
  const [notice, setNotice] = useState('');

  function update(value: string) {
    setText(value);
    localStorage.setItem(DRAFT_KEY, value);
  }

  async function send() {
    if (busy || !text.trim()) return;         // защита от двойного Enter
    setBusy(true);
    setError('');
    setRejected([]);
    setNotice('');
    try {
      const response = await fetch('/api/command', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text,
          today,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      if (response.status === 401) {
        router.push('/login');                // черновик остаётся в localStorage
        return;
      }
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? 'Не получилось');
        return;
      }
      update('');
      setRejected(body.rejected ?? []);
      if (!body.batchId) setNotice(body.reply ?? '');
      onResult(body as CommandResponse);
    } catch {
      setError('Нет связи с сервером');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-x-0 bottom-0 border-t border-neutral-500/20 bg-white/90 p-3 backdrop-blur dark:bg-neutral-950/90">
      <div className="mx-auto flex max-w-3xl gap-2">
        <input
          value={text}
          onChange={(e) => update(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          placeholder="Надиктуй задачи…"
          disabled={busy}
          className="flex-1 rounded-lg border border-neutral-300 px-3 py-2 text-sm disabled:opacity-60 dark:border-neutral-700 dark:bg-neutral-900"
        />
        <button
          onClick={() => void send()}
          disabled={busy || !text.trim()}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {busy ? '…' : 'Ок'}
        </button>
      </div>
      {error && <p className="mx-auto mt-1.5 max-w-3xl text-xs text-red-600">{error}</p>}
      {/* Не ошибка, а ответ на сказанное — поэтому нейтрально, а не красным. */}
      {notice && <p className="mx-auto mt-1.5 max-w-3xl text-xs opacity-70">{notice}</p>}
      {rejected.length > 0 && (
        <ul className="mx-auto mt-1.5 max-w-3xl space-y-0.5 text-xs text-amber-600">
          {rejected.map((item, index) => (
            <li key={index}>Не выполнено: {item.reason}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
