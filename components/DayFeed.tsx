'use client';

import { Fragment, useEffect, useRef } from 'react';
import { useNowMinute } from '@/components/useNowMinute';
import { eachDay, weekdayOf } from '@/lib/dates';
import {
  formatDayHeading,
  formatDayShort,
  formatDuration,
  formatTimeRange,
  minutesToClock,
} from '@/lib/format';
import type { Settings, Task } from '@/lib/types';

interface Props {
  from: string;
  to: string;
  tasks: Task[];
  settings: Settings;
  today: string;
  onSelect: (task: Task) => void;
}

/** Подряд идущие дни без задач показываются одной строкой. */
interface EmptyRun {
  kind: 'empty';
  days: string[];
}

interface DayWithTasks {
  kind: 'day';
  day: string;
  tasks: Task[];
}

type Row = EmptyRun | DayWithTasks;

/**
 * Раньше каждый пустой день занимал заголовок и строку «пусто» — четыре
 * пустых дня подряд съедали верх экрана, и первая настоящая задача
 * начиналась ниже середины. Сегодняшний день не сворачивается никогда,
 * даже пустой: его всегда надо видеть.
 */
function buildRows(days: string[], byDate: Map<string, Task[]>, today: string): Row[] {
  const rows: Row[] = [];

  for (const day of days) {
    const dayTasks = byDate.get(day)!;
    if (dayTasks.length > 0 || day === today) {
      rows.push({ kind: 'day', day, tasks: dayTasks });
      continue;
    }
    const last = rows.at(-1);
    if (last?.kind === 'empty') last.days.push(day);
    else rows.push({ kind: 'empty', days: [day] });
  }

  return rows;
}

function NowLine({ minute }: { minute: number }) {
  return (
    <li className="flex items-center gap-2 py-1" aria-hidden>
      <span className="text-[10px] font-semibold tabular-nums text-now">
        {minutesToClock(minute)}
      </span>
      <span className="h-px flex-1 bg-now opacity-45" />
    </li>
  );
}

export function DayFeed({ from, to, tasks, settings, today, onSelect }: Props) {
  const nowMinute = useNowMinute();
  const todayRef = useRef<HTMLElement | null>(null);

  /*
    Открыл приложение — и сразу видишь сегодня, без прокрутки. Лента идёт
    с понедельника, и к четвергу свой день оказывался ниже сгиба: каждый заход
    начинался с того, что человек мотает вниз, разглядывая уже прошедшее.

    Зависимости — [from, today], а НЕ список задач. Прокручиваем, когда
    сменилась показанная неделя (стрелки, «сегодня») или наступила полночь.
    Добавь сюда tasks — и лента дёргалась бы к сегодняшнему дню после каждой
    надиктованной фразы, отматывая назад то, что человек в этот момент листал.
  */
  useEffect(() => {
    const target = todayRef.current;
    // Неделя без сегодняшнего дня — соседняя. Там прокручивать не к чему,
    // и трогать позицию не за что.
    if (!target) return;

    // Высота липкой шапки замеряется, а не вписана числом: впиши — и первая
    // же правка шапки задвинет заголовок дня под неё, причём молча.
    const header = document.querySelector('header');
    const offset = (header?.getBoundingClientRect().height ?? 0) + 8;
    const top = target.getBoundingClientRect().top + window.scrollY - offset;

    // Прокрутка мгновенная, без behavior: 'smooth'. Плавная при открытии
    // читается как сбой — экран уезжает сам собой, пока человек ещё не понял,
    // что видит.
    window.scrollTo({ top: Math.max(0, top) });
  }, [from, today]);

  const days = eachDay(from, to);
  const byDate = new Map<string, Task[]>(days.map((day) => [day, []]));
  for (const task of tasks) byDate.get(task.date)?.push(task);

  const rows = buildRows(days, byDate, today);

  return (
    <div>
      {rows.map((row) => {
        if (row.kind === 'empty') {
          const first = formatDayShort(row.days[0], weekdayOf(row.days[0]));
          const last = row.days.at(-1)!;
          const label =
            row.days.length === 1
              ? first
              : `${first} – ${formatDayShort(last, weekdayOf(last))}`;
          return (
            <p
              key={row.days[0]}
              className="border-t border-hairline py-2.5 text-xs text-faint"
            >
              {label} · пусто
            </p>
          );
        }

        const isToday = row.day === today;
        // Линия текущего момента ставится перед первой задачей, которая ещё
        // не началась. Если все уже начались — в конец дня.
        let nowLinePlaced = nowMinute === null || !isToday;

        return (
          <section
            key={row.day}
            ref={isToday ? todayRef : undefined}
            className="pt-5 first:pt-0"
          >
            <div className="mb-0.5 flex items-center gap-2">
              <h2
                className={`text-[11px] font-semibold uppercase tracking-[0.12em] ${
                  isToday ? 'text-ink' : 'text-faint'
                }`}
              >
                {formatDayHeading(row.day, weekdayOf(row.day))}
              </h2>
              {isToday && (
                <span className="rounded-full bg-ink px-1.5 py-px text-[9px] font-semibold uppercase tracking-wider text-paper">
                  сегодня
                </span>
              )}
            </div>

            {row.tasks.length === 0 ? (
              <p className="border-t border-hairline py-2.5 text-xs text-faint">пусто</p>
            ) : (
              <ul>
                {row.tasks.map((task, index) => {
                  const color =
                    settings.categories.find((c) => c.id === task.categoryId)?.color ?? '#78716c';
                  const startsAt = task.startMinute ?? 0;
                  const line =
                    !nowLinePlaced && !task.allDay && startsAt >= nowMinute! ? (
                      <NowLine minute={nowMinute!} />
                    ) : null;
                  if (line) nowLinePlaced = true;

                  return (
                    <Fragment key={task.id}>
                      {line}
                      <li>
                        <button
                          onClick={() => onSelect(task)}
                          style={{ ['--cat' as string]: color }}
                          className={`flex w-full items-stretch gap-3 border-t py-2.5 text-left ${
                            isToday && index === 0
                              ? 'border-t-[1.5px] border-ink'
                              : 'border-hairline'
                          } ${task.done ? 'opacity-45' : ''}`}
                        >
                          <span className="cat-bar w-[3px] shrink-0 rounded-sm" />
                          <span className="min-w-0 flex-1">
                            <span
                              className={`block truncate text-base font-medium tracking-[-0.01em] ${
                                task.done ? 'line-through' : ''
                              }`}
                            >
                              {task.title}
                            </span>
                            <span className="mt-0.5 block text-[13px] tabular-nums text-muted">
                              {task.allDay
                                ? 'весь день'
                                : `${formatTimeRange(startsAt, task.durationMinutes)}${
                                    task.durationMinutes
                                      ? ` · ${formatDuration(task.durationMinutes)}`
                                      : ''
                                  }`}
                            </span>
                          </span>
                        </button>
                      </li>
                    </Fragment>
                  );
                })}
                {!nowLinePlaced && <NowLine minute={nowMinute!} />}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
