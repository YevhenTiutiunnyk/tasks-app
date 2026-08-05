'use client';

import { eachDay, weekdayOf } from '@/lib/dates';
import { formatDayHeading, minutesToClock } from '@/lib/format';
import type { Settings, Task } from '@/lib/types';

interface Props {
  from: string;
  to: string;
  tasks: Task[];
  settings: Settings;
  today: string;
  onSelect: (task: Task) => void;
}

export function DayFeed({ from, to, tasks, settings, today, onSelect }: Props) {
  const days = eachDay(from, to);
  const byDate = new Map<string, Task[]>(days.map((day) => [day, []]));
  for (const task of tasks) byDate.get(task.date)?.push(task);

  return (
    <div className="space-y-4">
      {days.map((day) => {
        const dayTasks = byDate.get(day)!;
        return (
          <section key={day}>
            <h2
              className={`mb-1.5 text-sm font-semibold ${
                day === today ? 'text-blue-600' : 'opacity-70'
              }`}
            >
              {formatDayHeading(day, weekdayOf(day))}
            </h2>
            {dayTasks.length === 0 ? (
              <p className="text-xs opacity-35">пусто</p>
            ) : (
              <ul className="space-y-1.5">
                {dayTasks.map((task) => {
                  const color =
                    settings.categories.find((c) => c.id === task.categoryId)?.color ?? '#64748b';
                  return (
                    <li key={task.id}>
                      <button
                        onClick={() => onSelect(task)}
                        style={{ borderLeftColor: color, backgroundColor: `${color}1a` }}
                        className={`flex w-full items-baseline gap-2 rounded-md border-l-2 px-2.5 py-2 text-left ${
                          task.done ? 'line-through opacity-50' : ''
                        }`}
                      >
                        <span className="min-w-[52px] text-xs tabular-nums opacity-70">
                          {task.allDay ? 'весь день' : minutesToClock(task.startMinute ?? 0)}
                        </span>
                        <span className="text-sm">{task.title}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
