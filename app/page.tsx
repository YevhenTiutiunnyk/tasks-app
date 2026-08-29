'use client';

import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ClarifyDialog, type ClarifyItem } from '@/components/ClarifyDialog';
import { CommandBar, type CommandResponse } from '@/components/CommandBar';
import { DayFeed } from '@/components/DayFeed';
import { TaskCard } from '@/components/TaskCard';
import { UndoToast } from '@/components/UndoToast';
import { WeekGrid } from '@/components/WeekGrid';
import { addDays } from '@/lib/dates';
import { formatWeekRange } from '@/lib/format';
import type { Settings, Task } from '@/lib/types';

interface WeekData {
  from: string;
  to: string;
  tasks: Task[];
  settings: Settings;
  hasKey: boolean;
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export default function Home() {
  const router = useRouter();
  const [anchor, setAnchor] = useState(todayIso);
  const [week, setWeek] = useState<WeekData | null>(null);
  const [wide, setWide] = useState(true);
  const [undo, setUndo] = useState<{ batchId: string; message: string } | null>(null);
  const [clarify, setClarify] = useState<ClarifyItem[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);
  const [actionError, setActionError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  // Все успешные ответы — команда, откат, уточнение, правка из карточки —
  // приходят неделей вокруг today. Показать такую неделю, не сдвинув anchor,
  // значит рассогласовать экран со стрелками: «←» отсчитает семь дней от
  // устаревшего якоря. Заодно снимаем сообщение о неудачной загрузке: на
  // экране снова свежая неделя с сервера.
  function showWeek(data: unknown) {
    setAnchor(todayIso());
    setWeek(data as WeekData);
    setLoadError('');
  }

  function handleResult(response: CommandResponse) {
    showWeek(response.week);
    if (response.batchId) {
      setUndo({ batchId: response.batchId, message: response.reply || 'Готово' });
    } else {
      // Иначе на экране осталась бы плашка от прошлой команды, и «Отменить»
      // откатило бы не то, о чём человек только что говорил.
      setUndo(null);
    }
    if (response.needsTime.length > 0) setClarify(response.needsTime);
  }

  async function runUndo() {
    if (!undo) return;
    setActionError('');
    try {
      const response = await fetch('/api/undo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ batchId: undo.batchId, today: todayIso() }),
      });
      if (response.status === 401) {
        router.push('/login');
        return;
      }
      if (!response.ok) {
        setActionError('Не получилось отменить');
        return;
      }
      const body = await response.json();
      showWeek(body.week);
      // Откатывается только самая свежая пачка. Пока плашка висела, человек мог
      // перетащить задачу мышью — и его «Отменить» уже ничего не откатит.
      // Без сообщения плашка просто исчезла бы, будто всё получилось.
      if (body.undone === false) {
        setActionError('Отменить не вышло: после этого уже были другие изменения');
      }
    } catch {
      setActionError('Нет связи с сервером');
    } finally {
      setUndo(null);
    }
  }

  // Тело без replace: меняем только день и время, остальные поля не трогаем.
  // Поставить здесь replace значило бы затереть название, длительность
  // и категорию, потому что перетаскивание их не знает.
  async function moveTask(taskId: string, date: string, startMinute: number) {
    setActionError('');
    try {
      const response = await fetch('/api/task', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ today: todayIso(), taskId, date, startMinute, scope: 'one' }),
      });
      if (response.status === 401) {
        router.push('/login');
        return;
      }
      if (!response.ok) {
        // Без сообщения задача просто отскочит на прежнее место, и человек
        // решит, что перетаскивание сломано.
        const payload = await response.json().catch(() => ({}));
        setActionError(payload.error ?? 'Не получилось перенести задачу');
        return;
      }
      showWeek((await response.json()).week);
    } catch {
      setActionError('Нет связи с сервером');
    }
  }

  useEffect(() => {
    const query = window.matchMedia('(min-width: 768px)');
    const sync = () => setWide(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/week?date=${anchor}`);
        // Без этих веток сбой загрузки не виден ничем: при 500 экран навсегда
        // оставался на «Загружаю…», а при обрыве связи fetch отклонялся
        // вообще без обработчика.
        if (response.status === 401) {
          router.push('/login');
          return;
        }
        if (!response.ok) {
          if (!cancelled) setLoadError('Не удалось загрузить неделю');
          return;
        }
        const loaded = await response.json();
        if (cancelled) return;
        setLoadError('');
        setWeek(loaded);
      } catch {
        if (!cancelled) setLoadError('Нет связи с сервером');
      }
    })();
    return () => { cancelled = true; };
  }, [anchor, reloadToken, router]);

  if (!week) {
    return loadError
      ? <main className="p-6 text-sm text-red-600">{loadError}</main>
      : <main className="p-6 text-sm opacity-60">Загружаю…</main>;
  }

  return (
    // w-full обязателен: mx-auto ставит автоматические поля, а они отменяют
    // растягивание флекс-элемента, и ширина становится по содержимому.
    // Раньше это скрывали длинные подписи дней.
    <main className="mx-auto w-full max-w-6xl p-4 pb-28">
      {/*
        Заголовок недели набран крупно и по-человечески: раньше здесь стояло
        '2026-08-03 — 2026-08-09', и на телефоне эта строка переносилась
        на две, налезая на стрелки.
      */}
      <header className="mb-4">
        <div className="flex items-baseline justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-[-0.02em]">
            {formatWeekRange(week.from, week.to)}
          </h1>
          <a href="/settings" className="shrink-0 text-[13px] text-muted hover:text-ink">
            Настройки
          </a>
        </div>
        <div className="mt-1 flex items-center gap-1 text-[13px] text-faint">
          <button
            onClick={() => setAnchor(addDays(anchor, -7))}
            aria-label="Предыдущая неделя"
            className="rounded px-1.5 py-0.5 hover:bg-hairline hover:text-ink"
          >
            ←
          </button>
          <button
            onClick={() => setAnchor(todayIso())}
            className="rounded px-1.5 py-0.5 hover:bg-hairline hover:text-ink"
          >
            сегодня
          </button>
          <button
            onClick={() => setAnchor(addDays(anchor, 7))}
            aria-label="Следующая неделя"
            className="rounded px-1.5 py-0.5 hover:bg-hairline hover:text-ink"
          >
            →
          </button>
        </div>
      </header>

      {loadError && (
        // Неделя на экране не та, что запрошена стрелками: anchor уже сдвинут,
        // а week остался прежним. Молча показывать старую неделю под новым
        // заголовком нельзя — стрелки будут выглядеть сломанными.
        <p className="mb-2 flex items-center gap-3 rounded-md bg-red-600/10 px-3 py-2 text-xs text-red-600">
          <span>{loadError}. На экране неделя {week.from} — {week.to}.</span>
          <button onClick={() => setReloadToken((n) => n + 1)} className="font-semibold underline">
            Повторить
          </button>
        </p>
      )}

      {wide ? (
        <WeekGrid
          from={week.from}
          to={week.to}
          tasks={week.tasks}
          settings={week.settings}
          today={todayIso()}
          onSelect={setSelected}
          onMove={(id, date, minute) => void moveTask(id, date, minute)}
        />
      ) : (
        <DayFeed
          from={week.from}
          to={week.to}
          tasks={week.tasks}
          settings={week.settings}
          today={todayIso()}
          onSelect={setSelected}
        />
      )}

      {undo && (
        <UndoToast message={undo.message} onUndo={() => void runUndo()} onDismiss={() => setUndo(null)} />
      )}
      {clarify.length > 0 && (
        <ClarifyDialog
          items={clarify}
          today={todayIso()}
          onDone={(week, remaining) => {
            showWeek(week);
            setClarify(remaining);
          }}
          onLater={() => setClarify([])}
        />
      )}
      {selected && (
        <TaskCard
          task={selected}
          settings={week.settings}
          today={todayIso()}
          onSaved={(updated, batchId) => {
            showWeek(updated);
            // batchId приходит только от удаления. Правку откатывает повторная
            // правка, а удалённую задачу вернуть больше нечем — поэтому
            // плашка отмены нужна именно здесь.
            if (batchId) setUndo({ batchId, message: 'Задача удалена' });
          }}
          onClose={() => setSelected(null)}
        />
      )}
      {actionError && (
        <button
          onClick={() => setActionError('')}
          className="fixed inset-x-0 bottom-20 z-10 mx-auto block w-fit rounded-lg bg-red-600 px-4 py-2.5 text-sm text-white shadow-lg"
        >
          {actionError}
        </button>
      )}
      {week.hasKey ? (
        <CommandBar today={todayIso()} onResult={handleResult} />
      ) : (
        // Та же внешняя обёртка, что у CommandBar (fixed inset-x-0 bottom-0):
        // плашка занимает его место, а не встаёт в поток — иначе на
        // заполненной неделе она уходит ниже сгиба, а pb-28 у <main>,
        // зарезервированный под исчезнувшую строку ввода, остаётся пустотой.
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
