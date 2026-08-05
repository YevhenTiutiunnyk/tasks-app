'use client';

import { useEffect, useState } from 'react';
import { ClarifyDialog, type ClarifyItem } from '@/components/ClarifyDialog';
import { CommandBar, type CommandResponse } from '@/components/CommandBar';
import { DayFeed } from '@/components/DayFeed';
import { TaskCard } from '@/components/TaskCard';
import { UndoToast } from '@/components/UndoToast';
import { WeekGrid } from '@/components/WeekGrid';
import { addDays } from '@/lib/dates';
import type { Settings, Task } from '@/lib/types';

interface WeekData {
  from: string;
  to: string;
  tasks: Task[];
  settings: Settings;
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export default function Home() {
  const [anchor, setAnchor] = useState(todayIso);
  const [week, setWeek] = useState<WeekData | null>(null);
  const [wide, setWide] = useState(true);
  const [undo, setUndo] = useState<{ batchId: string; message: string } | null>(null);
  const [clarify, setClarify] = useState<ClarifyItem[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);

  function handleResult(response: CommandResponse) {
    // /api/command всегда отвечает неделей вокруг today. Если пользователь листнул
    // на другую неделю, показать её ответ, не сдвинув anchor, значит рассогласовать
    // экран со стрелками: «←» отсчитает семь дней от устаревшего якоря.
    setAnchor(todayIso());
    setWeek(response.week as WeekData);
    if (response.batchId) {
      setUndo({ batchId: response.batchId, message: response.reply || 'Готово' });
    }
    if (response.needsTime.length > 0) setClarify(response.needsTime);
  }

  async function runUndo() {
    if (!undo) return;
    const response = await fetch('/api/undo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ batchId: undo.batchId, today: todayIso() }),
    });
    // /api/undo, как и /api/command, отвечает неделей вокруг today — сдвигаем
    // anchor симметрично handleResult, иначе заголовок разойдётся со стрелками.
    if (response.ok) {
      setAnchor(todayIso());
      setWeek((await response.json()).week);
    }
    setUndo(null);
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
    fetch(`/api/week?date=${anchor}`).then(async (response) => {
      if (response.ok && !cancelled) setWeek(await response.json());
    });
    return () => { cancelled = true; };
  }, [anchor]);

  if (!week) return <main className="p-6 text-sm opacity-60">Загружаю…</main>;

  return (
    <main className="mx-auto max-w-6xl p-3 pb-28">
      <header className="mb-3 flex items-center gap-2">
        <button onClick={() => setAnchor(addDays(anchor, -7))} className="rounded px-2 py-1 hover:bg-neutral-500/10">←</button>
        <button onClick={() => setAnchor(todayIso())} className="rounded px-2 py-1 text-sm hover:bg-neutral-500/10">Сегодня</button>
        <button onClick={() => setAnchor(addDays(anchor, 7))} className="rounded px-2 py-1 hover:bg-neutral-500/10">→</button>
        <span className="ml-auto text-sm opacity-60">{week.from} — {week.to}</span>
      </header>

      {wide ? (
        <WeekGrid
          from={week.from}
          to={week.to}
          tasks={week.tasks}
          settings={week.settings}
          today={todayIso()}
          onSelect={setSelected}
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
            // /api/clarify тоже отвечает неделей вокруг today — сдвигаем anchor
            // симметрично handleResult и runUndo, иначе заголовок разойдётся
            // со стрелками.
            setAnchor(todayIso());
            setWeek(week as WeekData);
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
          onSaved={(updated) => {
            // PATCH и DELETE /api/task тоже отвечают неделей вокруг today —
            // сдвигаем anchor так же, как в handleResult, runUndo и onDone
            // окна уточнения, иначе заголовок разойдётся со стрелками.
            setAnchor(todayIso());
            setWeek(updated as WeekData);
          }}
          onClose={() => setSelected(null)}
        />
      )}
      <CommandBar today={todayIso()} onResult={handleResult} />
    </main>
  );
}
