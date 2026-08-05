'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface ClarifyItem {
  taskId: string;
  title: string;
  question: string;
}

interface Props {
  items: ClarifyItem[];
  today: string;
  /**
   * Отдаёт обновлённую неделю и строки, с которыми ещё предстоит разобраться.
   * Пустой список размонтирует окно; непустой оставляет его открытым — так
   * сообщение о неразобранных фразах доживает до глаз пользователя.
   */
  onDone: (week: unknown, remaining: ClarifyItem[]) => void;
  onLater: () => void;
}

export function ClarifyDialog({ items, today, onDone, onLater }: Props) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>({});
  const [allDay, setAllDay] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError('');
    // Задачи с включённым тумблером остаются на весь день — их не отправляем.
    const answers = items
      .filter((item) => !allDay[item.taskId] && (values[item.taskId] ?? '').trim())
      .map((item) => ({ taskId: item.taskId, text: values[item.taskId] }));

    if (answers.length === 0) {
      setBusy(false);
      onLater();
      return;
    }

    try {
      const response = await fetch('/api/clarify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answers, today }),
      });
      if (response.status === 401) {
        router.push('/login');
        return;
      }
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? 'Не получилось');
        return;
      }
      const failed: string[] = body.failed ?? [];
      if (failed.length > 0) {
        // Неделю показываем сразу — часть задач уже встала на места, — но окно
        // не закрываем: иначе сообщение об ошибке умрёт в том же кадре, а
        // неразобранные задачи молча останутся на весь день.
        setError('Часть фраз разобрать не вышло — попробуй сказать иначе');
        onDone(body.week, items.filter((item) => failed.includes(item.taskId)));
        return;
      }
      onDone(body.week, []);
    } catch {
      setError('Нет связи с сервером');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-xl bg-white p-4 dark:bg-neutral-900">
        <h2 className="text-base font-semibold">Уточни время</h2>
        <p className="mb-3 text-xs opacity-60">
          {items.length === 1 ? 'Для одной задачи не понял, когда её ставить' : `Для ${items.length} задач не понял, когда их ставить`}
        </p>

        {items.map((item) => (
          <div key={item.taskId} className="border-t border-neutral-500/20 py-3">
            <p className="mb-2 text-sm font-medium">{item.title}</p>
            <div className="flex items-center gap-2">
              <input
                value={values[item.taskId] ?? ''}
                onChange={(e) => setValues({ ...values, [item.taskId]: e.target.value })}
                disabled={allDay[item.taskId]}
                placeholder="🎤 например: завтра в 8 утра, час"
                className="flex-1 rounded-md border border-neutral-300 px-2 py-1.5 text-xs disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-950"
              />
              <label className="flex shrink-0 items-center gap-1.5 text-[11px] opacity-80">
                <input
                  type="checkbox"
                  checked={allDay[item.taskId] ?? false}
                  onChange={(e) => setAllDay({ ...allDay, [item.taskId]: e.target.checked })}
                />
                весь день
              </label>
            </div>
          </div>
        ))}

        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

        <div className="mt-3 flex justify-end gap-2 border-t border-neutral-500/20 pt-3">
          <button onClick={onLater} className="rounded-md border border-neutral-500/30 px-3 py-1.5 text-xs">
            Позже
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy}
            className="rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white disabled:opacity-50"
          >
            {busy ? '…' : 'Готово'}
          </button>
        </div>
      </div>
    </div>
  );
}
