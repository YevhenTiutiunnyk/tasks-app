'use client';

import { useRef, useState } from 'react';
import { eachDay, weekdayOf } from '@/lib/dates';
import { formatDayLabel, minutesToClock } from '@/lib/format';
import { visibleHourRange } from '@/lib/grid';
import type { Settings, Task } from '@/lib/types';

const HOUR_HEIGHT = 44;   // пикселей на час

interface Props {
  from: string;
  to: string;
  tasks: Task[];
  settings: Settings;
  today: string;
  onSelect: (task: Task) => void;
  onMove: (taskId: string, date: string, startMinute: number) => void;
}

function colorOf(task: Task, settings: Settings): string {
  return settings.categories.find((c) => c.id === task.categoryId)?.color ?? '#64748b';
}

export function WeekGrid({ from, to, tasks, settings, today, onSelect, onMove }: Props) {
  const days = eachDay(from, to);

  const [dragging, setDragging] = useState<{ taskId: string; grabOffset: number } | null>(null);
  // Откуда начали жать. Без этого обычный клик мышью неотличим от переноса:
  // begin() выставляет dragging прямо на pointerdown, и pointerup считает
  // каждый клик перетаскиванием — карточка не открылась бы никогда.
  const pressStart = useRef<{ x: number; y: number } | null>(null);

  // Рабочий день плюс два часа с каждой стороны, растянутый под реальные задачи недели.
  const { firstHour, lastHour } = visibleHourRange(tasks, settings);
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
            <div key={day} data-day={day} className="relative border-l border-neutral-500/15">
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
                    onPointerDown={(event) => {
                      // Правая кнопка не должна начинать перенос: иначе контекстное меню
                      // приходит вместе с захватом указателя и мигающей полупрозрачностью.
                      if (event.pointerType === 'mouse' && event.button !== 0) return;
                      // Долгое нажатие на телефоне, обычное нажатие мышью.
                      const target = event.currentTarget;
                      const offset = event.clientY - target.getBoundingClientRect().top;
                      pressStart.current = { x: event.clientX, y: event.clientY };
                      const begin = () => {
                        target.setPointerCapture(event.pointerId);
                        setDragging({ taskId: task.id, grabOffset: offset });
                      };
                      if (event.pointerType === 'mouse') begin();
                      else {
                        const timer = setTimeout(begin, 350);
                        // Сработает ровно один из двух, поэтому снимаем оба разом — иначе
                        // на узле кнопки копились бы осиротевшие слушатели, по одному
                        // на каждое касание.
                        const stop = new AbortController();
                        const cancel = () => { clearTimeout(timer); stop.abort(); };
                        target.addEventListener('pointerup', cancel, { signal: stop.signal });
                        target.addEventListener('pointercancel', cancel, { signal: stop.signal });
                      }
                    }}
                    onPointerUp={(event) => {
                      const origin = pressStart.current;
                      pressStart.current = null;
                      // Мышью dragging выставляется сразу на нажатие, поэтому одного его мало:
                      // отличаем клик от переноса по тому, сдвинулся ли указатель.
                      const moved = origin
                        ? Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 4
                        : false;
                      if (dragging?.taskId !== task.id || !moved) {
                        setDragging(null);
                        onSelect(task);
                        return;
                      }
                      setDragging(null);
                      const column = document
                        .elementsFromPoint(event.clientX, event.clientY)
                        .find((el) => el instanceof HTMLElement && el.dataset.day) as HTMLElement | undefined;
                      if (!column) return;
                      const rect = column.getBoundingClientRect();
                      const rawMinute =
                        firstHour * 60 + ((event.clientY - dragging.grabOffset - rect.top) / HOUR_HEIGHT) * 60;
                      const snapped = Math.round(rawMinute / 15) * 15;   // шаг 15 минут
                      const clamped = Math.max(0, Math.min(1439, snapped));
                      onMove(task.id, column.dataset.day!, clamped);
                    }}
                    onPointerCancel={() => {
                      // Без этого отменённый жест оставляет задачу навсегда полупрозрачной,
                      // а dragging — выставленным: следующий быстрый свайп по той же задаче
                      // проехал бы проверку и перенёс её со старым grabOffset.
                      pressStart.current = null;
                      setDragging(null);
                    }}
                    onClick={(event) => {
                      // Enter и пробел на кнопке дают click, но не pointerup, поэтому без
                      // этого карточка перестала бы открываться с клавиатуры. detail === 0
                      // бывает только у клика, синтезированного с клавиатуры.
                      if (event.detail === 0) onSelect(task);
                    }}
                    style={{
                      top,
                      height,
                      borderLeftColor: colorOf(task, settings),
                      backgroundColor: `${colorOf(task, settings)}26`,
                      opacity: dragging?.taskId === task.id ? 0.5 : undefined,
                      touchAction: 'none',
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
