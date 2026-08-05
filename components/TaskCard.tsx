'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { SeriesChoiceDialog } from './SeriesChoiceDialog';
import { clockToMinutes, minutesToClock } from '@/lib/format';
import type { Settings, Task } from '@/lib/types';

interface Props {
  task: Task;
  settings: Settings;
  today: string;
  onSaved: (week: unknown) => void;
  onClose: () => void;
}

export function TaskCard({ task, settings, today, onSaved, onClose }: Props) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState(task.title);
  const [date, setDate] = useState(task.date);
  const [clock, setClock] = useState(task.allDay ? '' : minutesToClock(task.startMinute ?? 0));
  const [duration, setDuration] = useState(String(task.durationMinutes ?? 60));
  const [allDay, setAllDay] = useState(task.allDay);
  const [categoryId, setCategoryId] = useState(task.categoryId ?? '');
  const [error, setError] = useState('');
  const [pending, setPending] = useState<null | 'save' | 'delete'>(null);

  const isSeries = task.id.startsWith('occ:');

  async function send(method: 'PATCH' | 'DELETE', scope?: 'one' | 'series') {
    if (busy) return;                          // защита от двойного клика
    const body: Record<string, unknown> = { today, taskId: task.id, scope };

    if (method === 'PATCH') {
      if (!title.trim()) {
        setError('Название не может быть пустым');
        setPending(null);
        return;
      }
      const startMinute = allDay ? null : clockToMinutes(clock);
      if (!allDay && startMinute === null) {
        setError('Время нужно в формате 9:30');
        setPending(null);
        return;
      }
      const durationMinutes = allDay ? null : Number(duration);
      if (!allDay && (!Number.isFinite(durationMinutes) || durationMinutes! <= 0)) {
        setError('Длительность — число минут больше нуля');
        setPending(null);
        return;
      }
      Object.assign(body, {
        title: title.trim(), date, startMinute, durationMinutes, allDay,
        categoryId: categoryId || null,
      });
    }

    setBusy(true);
    try {
      const response = await fetch('/api/task', {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.status === 401) {
        router.push('/login');
        return;
      }
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? 'Не получилось');
        setPending(null);
        return;
      }
      onSaved(payload.week);
      onClose();
    } catch {
      // Без этого обрыв связи оставлял бы карточку молча висеть, а выбор
      // области для серии — открытым поверх неё.
      setError('Нет связи с сервером');
      setPending(null);
    } finally {
      setBusy(false);
    }
  }

  async function toggleDone() {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch('/api/task', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ today, taskId: task.id, done: !task.done }),
      });
      if (response.status === 401) {
        router.push('/login');
        return;
      }
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? 'Не получилось');
        return;
      }
      onSaved(payload.week);
      onClose();
    } catch {
      setError('Нет связи с сервером');
    } finally {
      setBusy(false);
    }
  }

  function start(action: 'save' | 'delete') {
    setError('');
    if (isSeries) {
      setPending(action);
      return;
    }
    void send(action === 'save' ? 'PATCH' : 'DELETE');
  }

  return (
    <>
      <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4">
        <div className="w-full max-w-sm space-y-2.5 rounded-xl bg-white p-4 dark:bg-neutral-900">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-950"
          />

          <div className="flex gap-2">
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="flex-1 rounded-md border border-neutral-300 px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-950"
            />
            <label className="flex items-center gap-1.5 text-[11px] opacity-80">
              <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} />
              весь день
            </label>
          </div>

          {!allDay && (
            <div className="flex gap-2">
              <input
                value={clock}
                onChange={(e) => setClock(e.target.value)}
                placeholder="9:30"
                className="w-24 rounded-md border border-neutral-300 px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-950"
              />
              <input
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                placeholder="минут"
                inputMode="numeric"
                className="w-24 rounded-md border border-neutral-300 px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-950"
              />
            </div>
          )}

          <select
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="">без категории</option>
            {settings.categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>

          {error && <p className="text-xs text-red-600">{error}</p>}

          <div className="flex items-center gap-2 border-t border-neutral-500/20 pt-2.5">
            {!isSeries && (
              <button onClick={() => void toggleDone()} className="text-xs opacity-70">
                {task.done ? 'Вернуть в работу' : 'Выполнено'}
              </button>
            )}
            <button onClick={() => start('delete')} className="text-xs text-red-600">Удалить</button>
            <button onClick={onClose} className="ml-auto text-xs opacity-60">Отмена</button>
            <button
              onClick={() => start('save')}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs text-white"
            >
              Сохранить
            </button>
          </div>
        </div>
      </div>

      {pending && (
        <SeriesChoiceDialog
          action={pending === 'delete' ? 'удалить' : 'изменить'}
          // У правила повтора нет даты — только дни недели, — поэтому правка
          // всей серии дату проигнорирует. Без предупреждения она пропала бы
          // молча, а остальные поля сохранились: выглядело бы как наполовину
          // сработавшее сохранение.
          note={
            pending === 'save' && date !== task.date
              ? 'У серии нет одной даты — новая дата применится только к этому занятию.'
              : undefined
          }
          onChoose={(scope) => void send(pending === 'delete' ? 'DELETE' : 'PATCH', scope)}
          onCancel={() => setPending(null)}
        />
      )}
    </>
  );
}
