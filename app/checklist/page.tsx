'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Chevron } from '@/components/Chevron';
import { CommandBar } from '@/components/CommandBar';
import { todayIso } from '@/lib/dates';
import { formatTimeRange } from '@/lib/format';
import { parseOccurrenceId } from '@/lib/recurrence';
import type { Task } from '@/lib/types';

interface ChecklistData {
  today: Task[];
  week: Task[];
  month: Task[];
  hasKey: boolean;
}

/**
 * Одна секция чеклиста.
 *
 * Объявлена на уровне модуля, а НЕ внутри Checklist. Компонент, объявленный
 * в теле другого компонента, пересоздаётся при каждом рендере родителя: React
 * видит новый тип и размонтирует поддерево вместо обновления. Здесь это стоило
 * бы мигания списка на каждой отметке галочки.
 */
function Section({
  title,
  tasks,
  busy,
  onToggle,
}: {
  title: string;
  tasks: Task[];
  busy: boolean;
  onToggle: (task: Task) => void;
}) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{title}</h2>
      {tasks.length === 0 ? (
        <p className="border-t border-hairline py-2.5 text-xs text-faint">пусто</p>
      ) : (
        <ul>
          {tasks.map((task) => {
            // Тот же признак, что и в карточке задачи (components/TaskCard.tsx):
            // вхождение серии, а не собственная строка в tasks. PATCH /api/task
            // отказывает в отметке выполнения по такому id (сначала нужно
            // отвязать вхождение правкой), поэтому вместо галочки, которая
            // гарантированно ответит 400, — обычный текст без интерактива.
            const isSeries = parseOccurrenceId(task.id) !== null;
            const body = (
              <>
                <span className="min-w-0 flex-1">
                  <span className={`block text-[15px] ${task.done ? 'line-through' : ''}`}>
                    {task.title}
                  </span>
                  {!task.allDay && task.startMinute !== null && (
                    <span className="mt-0.5 block text-[13px] tabular-nums text-muted">
                      {formatTimeRange(task.startMinute, task.durationMinutes)}
                    </span>
                  )}
                </span>
              </>
            );

            if (isSeries) {
              return (
                <li key={task.id}>
                  <div
                    className={`flex w-full items-start gap-3 border-t border-hairline py-3 text-left ${
                      task.done ? 'opacity-45' : ''
                    }`}
                  >
                    {body}
                  </div>
                </li>
              );
            }

            return (
              <li key={task.id}>
                <button
                  onClick={() => onToggle(task)}
                  disabled={busy}
                  aria-pressed={task.done}
                  className={`flex w-full items-start gap-3 border-t border-hairline py-3 text-left disabled:opacity-50 ${
                    task.done ? 'opacity-45' : ''
                  }`}
                >
                  <span
                    aria-hidden
                    className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded border ${
                      task.done ? 'border-ink bg-ink text-paper' : 'border-hairline bg-surface'
                    }`}
                  >
                    {task.done ? '✓' : ''}
                  </span>
                  {body}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * Чеклист: что осталось сделать сегодня, на этой неделе и в этом месяце.
 *
 * Расписание отвечает на вопрос «когда», чеклист — «что осталось». Поэтому
 * здесь нет ни сетки, ни перетаскивания, ни листания периодов: только текущие
 * три периода и галочки.
 */
export default function Checklist() {
  const router = useRouter();
  const [data, setData] = useState<ChecklistData | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/checklist?date=${todayIso()}`);
      if (response.status === 401) {
        router.push('/login');
        return;
      }
      if (!response.ok) {
        setError('Не получилось загрузить чеклист');
        return;
      }
      setData(await response.json());
      setError('');
    } catch {
      setError('Нет связи с сервером');
    }
  }, [router]);

  useEffect(() => {
    void (async () => {
      await load();
    })();
  }, [load]);

  /**
   * Отметка выполнения идёт тем же роутом, что и галочка в карточке задачи.
   * Второго способа помечать сделанное не заводим: два пути к одному флагу
   * разошлись бы, и будущий отчёт считал бы не то.
   */
  async function toggle(task: Task) {
    if (busy) return;
    setBusy(true);
    try {
      const response = await fetch('/api/task', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ today: todayIso(), taskId: task.id, done: !task.done }),
      });
      if (response.status === 401) {
        router.push('/login');
        return;
      }
      if (!response.ok) {
        // Как в карточке задачи: сервер объясняет причину конкретнее
        // общей фразы — например, что вхождение серии сначала нужно
        // отвязать правкой, и только потом отмечать выполненным.
        const payload = await response.json().catch(() => ({}));
        setError(payload.error ?? 'Не получилось отметить');
        return;
      }
      // Перечитываем чеклист целиком, а не правим состояние на месте: роут
      // задач отвечает неделей расписания, а нам нужны три секции.
      await load();
    } catch {
      setError('Нет связи с сервером');
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return <main className="p-5 text-sm opacity-60">{error || 'Загружаю…'}</main>;
  }

  return (
    <main className="mx-auto max-w-md space-y-5 p-5 pb-28">
      <div className="flex items-center gap-3">
        <Link
          href="/"
          className="flex h-11 shrink-0 touch-manipulation items-center gap-1.5 rounded-lg border border-hairline bg-surface pl-2.5 pr-4 text-[13px] text-ink hover:bg-hairline active:bg-hairline"
        >
          <Chevron direction="left" />
          к расписанию
        </Link>
        <h1 className="text-lg font-semibold">Чеклист</h1>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      <Section title="Сегодня" tasks={data.today} busy={busy} onToggle={(t) => void toggle(t)} />
      <Section title="На этой неделе" tasks={data.week} busy={busy} onToggle={(t) => void toggle(t)} />
      <Section title="В этом месяце" tasks={data.month} busy={busy} onToggle={(t) => void toggle(t)} />

      {data.hasKey ? (
        <CommandBar today={todayIso()} onResult={() => void load()} />
      ) : (
        <div className="fixed inset-x-0 bottom-0 border-t border-hairline bg-paper/85 p-4 backdrop-blur">
          <p className="mx-auto max-w-3xl text-[15px] text-muted">
            Нужен свой ключ Anthropic, чтобы надиктовывать задачи.{' '}
            <Link href="/settings" className="underline">
              Завести в настройках
            </Link>
          </p>
        </div>
      )}
    </main>
  );
}
