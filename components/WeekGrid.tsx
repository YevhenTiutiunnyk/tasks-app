'use client';

import { useRef, useState } from 'react';
import { useNowMinute } from '@/components/useNowMinute';
import { eachDay, weekdayOf } from '@/lib/dates';
import { formatDayLabel, formatTimeRange, meetingsWord, minutesToClock } from '@/lib/format';
import { eventsOutsideRange, visibleHourRange } from '@/lib/grid';
import type { EventDay, Settings, Task } from '@/lib/types';

const HOUR_HEIGHT = 44;   // пикселей на час

interface Props {
  from: string;
  to: string;
  tasks: Task[];
  /** Встречи Google. Только читаются: без перетаскивания и без карточки. */
  events: EventDay[];
  settings: Settings;
  today: string;
  onSelect: (task: Task) => void;
  onMove: (taskId: string, date: string, startMinute: number) => void;
}

function colorOf(task: Task, settings: Settings): string {
  return settings.categories.find((c) => c.id === task.categoryId)?.color ?? '#64748b';
}

export function WeekGrid({ from, to, tasks, events, settings, today, onSelect, onMove }: Props) {
  const days = eachDay(from, to);

  const [dragging, setDragging] = useState<{ taskId: string; grabOffset: number } | null>(null);
  // Откуда начали жать. Без этого обычный клик мышью неотличим от переноса:
  // begin() выставляет dragging прямо на pointerdown, и pointerup считает
  // каждый клик перетаскиванием — карточка не открылась бы никогда.
  const pressStart = useRef<{ x: number; y: number } | null>(null);

  const nowMinute = useNowMinute();

  /**
   * Раскрытые края сетки. Неделя — часть состояния намеренно: разворот
   * принадлежит той неделе, где его сделали, и при перелистывании края
   * снова свёрнуты.
   *
   * Без этого один ночной перелёт растягивал бы на все сутки каждую
   * следующую неделю, которую человек листает, — цена одного дела
   * платилась бы вечно. Сброс сделан сравнением при отрисовке, а не
   * эффектом: setState внутри эффекта даёт лишнюю перерисовку, и правило
   * react-hooks это запрещает.
   */
  const [expanded, setExpanded] = useState({ week: from, before: false, after: false });
  const open = expanded.week === from ? expanded : { week: from, before: false, after: false };

  // Базовый диапазон считается по задачам: это дела человека, и сетка обязана
  // вмещать их всегда. Встречи в него не входят — иначе одна встреча в час
  // ночи добавляет девять часов пустоты, через которую надо прокручиваться
  // к настоящему дню.
  const base = visibleHourRange(tasks, settings);
  const hidden = eventsOutsideRange(events, base.firstHour, base.lastHour);

  // Скрытое показывается не молча: у края висит отметка, и по нажатию сетка
  // раскрывается ровно в ту сторону, где что-то есть. Молчаливое сокрытие —
  // худший из вариантов: на телефоне встреча видна в ленте, и два экрана
  // расходились бы в том, что вообще существует.
  const { firstHour, lastHour } = visibleHourRange(tasks, settings, [
    ...(open.before ? hidden.before : []),
    ...(open.after ? hidden.after : []),
  ]);
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

  const allDayEventsByDate = new Map<string, EventDay[]>();
  const timedEventsByDate = new Map<string, EventDay[]>();
  for (const day of days) {
    allDayEventsByDate.set(day, []);
    timedEventsByDate.set(day, []);
  }
  for (const event of events) {
    (event.allDay ? allDayEventsByDate : timedEventsByDate).get(event.date)?.push(event);
  }

  return (
    <div className="overflow-x-auto">
      <div className="min-w-[760px]">
        <div className="grid" style={{ gridTemplateColumns: '52px repeat(7, 1fr)' }}>
          <div />
          {days.map((day) => (
            <div
              key={day}
              // Сегодня отмечено насыщенностью и линией под днём, а не цветом:
              // синий уже занят категорией и спорил бы с ней по смыслу.
              className={`px-1 pb-1.5 text-center text-[11px] uppercase tracking-[0.12em] ${
                day === today
                  ? 'border-b-[1.5px] border-ink font-semibold text-ink'
                  : 'text-faint'
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
                  style={{ ['--cat' as string]: colorOf(task, settings) }}
                  className={`cat-tint cat-border block w-full truncate rounded-md border-l-2 px-1.5 py-1 text-left text-[11px] ${
                    task.done ? 'line-through opacity-50' : ''
                  }`}
                >
                  {task.title}
                </button>
              ))}
              {allDayEventsByDate.get(day)!.map((event) => (
                // Встреча только читается: без onClick и цвета категории — рамка,
                // подложка и текст приглушённые, чтобы не выдать её за задачу.
                <div
                  key={`${event.calendarId}:${event.eventId}:${event.date}`}
                  className="block w-full truncate rounded-md border border-hairline bg-surface px-1.5 py-1 text-left text-[11px] text-faint"
                >
                  {event.title}
                </div>
              ))}
            </div>
          ))}
        </div>

        {hidden.before.length > 0 && !open.before && (
          <EdgeNotice
            count={hidden.before.length}
            direction="before"
            onClick={() => setExpanded({ ...open, before: true })}
          />
        )}

        <div
          className="relative grid"
          style={{ gridTemplateColumns: '52px repeat(7, 1fr)', height: gridHeight }}
        >
          <div className="relative">
            {hours.map((hour, index) => (
              <div
                key={hour}
                className="absolute right-2 -translate-y-1/2 text-[10px] tabular-nums text-faint"
                style={{ top: index * HOUR_HEIGHT }}
              >
                {minutesToClock(hour * 60)}
              </div>
            ))}
          </div>

          {days.map((day) => (
            <div key={day} data-day={day} className="relative border-l border-hairline">
              {hours.map((hour, index) => (
                <div
                  key={hour}
                  className="absolute inset-x-0 border-t border-hairline"
                  style={{ top: index * HOUR_HEIGHT }}
                />
              ))}

              {/* Линия текущего момента — только в сегодняшней колонке. */}
              {day === today && nowMinute !== null && (
                <div
                  className="pointer-events-none absolute inset-x-0 z-10 h-px bg-now opacity-70"
                  style={{ top: ((nowMinute - firstHour * 60) / 60) * HOUR_HEIGHT }}
                  aria-hidden
                />
              )}

              {timedEventsByDate.get(day)!.map((event) => {
                const start = event.startMinute ?? 0;
                const top = ((start - firstHour * 60) / 60) * HOUR_HEIGHT;
                const full = Math.max(18, ((event.durationMinutes ?? 60) / 60) * HOUR_HEIGHT - 2);
                const height = Math.max(18, Math.min(full, gridHeight - top));
                return (
                  // pointer-events-none: встреча лежит под задачами и не должна
                  // перехватывать клик или перетаскивание, даже если блоки совпали.
                  <div
                    key={`${event.calendarId}:${event.eventId}:${event.date}`}
                    style={{ top, height }}
                    className="pointer-events-none absolute inset-x-1 flex flex-col items-stretch justify-start overflow-hidden rounded-md border border-hairline bg-surface px-2 py-1 text-left text-[11px] leading-tight text-faint"
                  >
                    <span className="block truncate font-medium">{event.title}</span>
                    <span className="block text-[10px] tabular-nums">
                      {formatTimeRange(start, event.durationMinutes)}
                    </span>
                  </div>
                );
              })}

              {timedByDate.get(day)!.map((task) => {
                const start = task.startMinute ?? 0;
                const top = ((start - firstHour * 60) / 60) * HOUR_HEIGHT;
                const full = Math.max(18, ((task.durationMinutes ?? 60) / 60) * HOUR_HEIGHT - 2);
                // Задача, переходящая за полночь, иначе свесилась бы ниже сетки:
                // верхняя граница диапазона упирается в 24:00 и дальше не растёт.
                // Обрезаем блок по низу — настоящий конец всё равно написан на нём.
                const height = Math.max(18, Math.min(full, gridHeight - top));
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
                      ['--cat' as string]: colorOf(task, settings),
                      opacity: dragging?.taskId === task.id ? 0.5 : undefined,
                      touchAction: 'none',
                    }}
                    // flex-col прижимает подпись к верху блока: у кнопки
                    // содержимое по умолчанию центрируется, и в высоком блоке
                    // название висело посередине, а не там, где задача начинается.
                    className={`cat-tint cat-border absolute inset-x-1 flex flex-col items-stretch justify-start overflow-hidden rounded-md border-l-2 px-2 py-1 text-left text-[11px] leading-tight ${
                      task.done ? 'line-through opacity-50' : ''
                    }`}
                  >
                    <span className="block truncate font-medium">{task.title}</span>
                    <span className="block text-[10px] tabular-nums text-muted">
                      {formatTimeRange(start, task.durationMinutes)}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {hidden.after.length > 0 && !open.after && (
          <EdgeNotice
            count={hidden.after.length}
            direction="after"
            onClick={() => setExpanded({ ...open, after: true })}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Отметка у края сетки: «есть встречи, которых отсюда не видно».
 *
 * Кнопка во всю ширину, а не значок: попасть в неё надо пальцем на телефоне,
 * а мелкие цели в этом проекте уже приводили к промахам. Вид приглушённый,
 * как у самих встреч, — это подсказка, а не дело в расписании.
 */
function EdgeNotice({
  count,
  direction,
  onClick,
}: {
  count: number;
  direction: 'before' | 'after';
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="block w-full touch-manipulation rounded-md border border-hairline bg-surface px-2 py-1.5 text-[11px] text-faint active:bg-hairline"
    >
      {direction === 'before' ? '↑' : '↓'} {count} {meetingsWord(count)}{' '}
      {direction === 'before' ? 'раньше' : 'позже'} — показать
    </button>
  );
}
