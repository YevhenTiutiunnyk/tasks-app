'use client';

import { useEffect, useState } from 'react';
import { DayFeed } from '@/components/DayFeed';
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
          onSelect={(task) => console.log('выбрана задача', task)}
        />
      ) : (
        <DayFeed
          from={week.from}
          to={week.to}
          tasks={week.tasks}
          settings={week.settings}
          today={todayIso()}
          onSelect={(task) => console.log('выбрана задача', task)}
        />
      )}
    </main>
  );
}
