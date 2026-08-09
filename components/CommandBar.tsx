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
    <div className="fixed inset-x-0 bottom-0 border-t border-hairline bg-paper/85 p-4 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center gap-2">
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
          className="min-w-0 flex-1 rounded-full border border-hairline bg-surface px-4 py-2.5 text-[15px] placeholder:text-faint focus:border-ink focus:outline-none disabled:opacity-60"
        />
        <button
          onClick={() => void send()}
          disabled={busy || !text.trim()}
          className="shrink-0 rounded-full bg-ink px-5 py-2.5 text-[15px] font-medium text-paper transition-opacity disabled:opacity-30"
        >
          {busy ? '…' : 'Ок'}
        </button>
      </div>
      {error && <p className="mx-auto mt-2 max-w-3xl text-[13px] text-red-600">{error}</p>}
      {/* Не ошибка, а ответ на сказанное — поэтому нейтрально, а не красным. */}
      {notice && <p className="mx-auto mt-2 max-w-3xl text-[13px] text-muted">{notice}</p>}
      {rejected.length > 0 && (
        <ul className="mx-auto mt-2 max-w-3xl space-y-0.5 text-[13px] text-now">
          {rejected.map((item, index) => (
            <li key={index}>Не выполнено: {item.reason}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
