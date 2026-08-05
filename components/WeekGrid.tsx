'use client';

import { eachDay, weekdayOf } from '@/lib/dates';
import { formatDayLabel, minutesToClock } from '@/lib/format';
import type { Settings, Task } from '@/lib/types';

const HOUR_HEIGHT = 44;   // пикселей на час

interface Props {
  from: string;
  to: string;
  tasks: Task[];
  settings: Settings;
  today: string;
  onSelect: (task: Task) => void;
}

function colorOf(task: Task, settings: Settings): string {
  return settings.categories.find((c) => c.id === task.categoryId)?.color ?? '#64748b';
}

export function WeekGrid({ from, to, tasks, settings, today, onSelect }: Props) {
  const days = eachDay(from, to);

  // Показываем на два часа шире рабочего дня, но не выходя за сутки.
  const firstHour = Math.max(0, Math.floor(settings.workStartMinute / 60) - 2);
  const lastHour = Math.min(24, Math.ceil(settings.workEndMinute / 60) + 2);
  const hours = Array.from({ length: lastHour - firstHour }, (_, i) => firstHour + i);
  const gridHeight = hours.length * HOUR_HEIGHT;

  const allDayByDate = new Map<string, Task[]>();
  const timedByDate = new Map<string, Task[]>();
  for (const day of days) {
    allDayByDate.set(day, []);
    timedByDate.set(day, []);
  }
  for (const task of tasks) {
    (task.allDay ? allDayByDate : timedByDate).get(task.date)?.push(task);
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[760px]">
        <div className="grid" style={{ gridTemplateColumns: '52px repeat(7, 1fr)' }}>
          <div />
          {days.map((day) => (
            <div
              key={day}
              className={`px-1 pb-1 text-center text-xs uppercase tracking-wide ${
                day === today ? 'font-bold text-blue-600' : 'opacity-60'
              }`}
            >
              {formatDayLabel(day, weekdayOf(day))}
            </div>
          ))}
        </div>

        <div className="grid" style={{ gridTemplateColumns: '52px repeat(7, 1fr)' }}>
          <div />
          {days.map((day) => (
            <div key={day} className="space-y-1 px-1 pb-1">
              {allDayByDate.get(day)!.map((task) => (
                <button
                  key={task.id}
                  onClick={() => onSelect(task)}
                  style={{ borderLeftColor: colorOf(task, settings) }}
                  className={`block w-full truncate rounded border-l-2 bg-neutral-500/10 px-1.5 py-1 text-left text-[11px] ${
                    task.done ? 'line-through opacity-50' : ''
                  }`}
                >
                  {task.title}
                </button>
              ))}
            </div>
          ))}
        </div>

        <div
          className="relative grid"
          style={{ gridTemplateColumns: '52px repeat(7, 1fr)', height: gridHeight }}
        >
          <div className="relative">
            {hours.map((hour, index) => (
              <div
                key={hour}
                className="absolute right-1 -translate-y-1/2 text-[10px] opacity-45"
                style={{ top: index * HOUR_HEIGHT }}
              >
                {minutesToClock(hour * 60)}
              </div>
            ))}
          </div>

          {days.map((day) => (
            <div key={day} className="relative border-l border-neutral-500/15">
              {hours.map((hour, index) => (
                <div
                  key={hour}
                  className="absolute inset-x-0 border-t border-neutral-500/15"
                  style={{ top: index * HOUR_HEIGHT }}
                />
              ))}

              {timedByDate.get(day)!.map((task) => {
                const start = task.startMinute ?? 0;
                const top = ((start - firstHour * 60) / 60) * HOUR_HEIGHT;
                const height = Math.max(18, ((task.durationMinutes ?? 60) / 60) * HOUR_HEIGHT - 2);
                return (
                  <button
                    key={task.id}
                    onClick={() => onSelect(task)}
                    style={{
                      top,
                      height,
                      borderLeftColor: colorOf(task, settings),
                      backgroundColor: `${colorOf(task, settings)}26`,
                    }}
                    className={`absolute inset-x-1 overflow-hidden rounded border-l-2 px-1.5 py-0.5 text-left text-[11px] leading-tight ${
                      task.done ? 'line-through opacity-50' : ''
                    }`}
                  >
                    <span className="block truncate font-medium">{task.title}</span>
                    <span className="block text-[9px] opacity-70">{minutesToClock(start)}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
