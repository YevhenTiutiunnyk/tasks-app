import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import webpush from 'web-push';
import {
  getChecklistTasks,
  getEventsBetween,
  getNotifiableUsers,
  getSentKeys,
  getSettings,
  getSubscriptions,
  getTasksByIds,
  getWeekSnapshot,
  markSent,
  purgeOldSent,
  removeSubscription,
  saveReport,
  saveWeekSnapshot,
  type PushSubscriptionRow,
} from '@/lib/db';
import { formatTimeRange } from '@/lib/format';
import { eventKey, nowInZone, selectDue, selectDueEvents } from '@/lib/notify';
import { getTimezone } from '@/lib/db';
import { addDays } from '@/lib/dates';
import { loadRange } from '@/lib/week';
import { splitIntoDays } from '@/lib/calendar';
import { runWeeklyReport } from '@/lib/report-run';
import { describeReport } from '@/lib/report';
import { calendarDeps, syncUser } from '@/lib/calendar-run';
import type { EventDay, Task } from '@/lib/types';

/**
 * Отправка напоминаний. Дёргается планировщиком Supabase раз в минуту.
 *
 * Роут исключён из матчера в proxy.ts: у планировщика нет и не может быть
 * сессии. Вместо неё — общий секрет в заголовке.
 */

function secretMatches(provided: string | null): boolean {
  const expected = process.env.NOTIFY_SECRET;
  if (!expected || !provided) return false;

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual падает на буферах разной длины, поэтому длину сверяем
  // отдельно. Она и так не секрет.
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Текст пуша — общий для задач и встреч: обоим нужны только заголовок
 * и время, а не полный набор полей Task или EventDay.
 */
function describe(
  item: Pick<Task, 'title' | 'startMinute' | 'durationMinutes'>,
  beforeMinutes: number,
): { title: string; body: string } {
  const when = item.startMinute === null
    ? ''
    : ` · ${formatTimeRange(item.startMinute, item.durationMinutes)}`;
  return {
    title: item.title,
    body: `Через ${beforeMinutes} мин${when}`,
  };
}

/**
 * Разослать один пуш по всем подпискам владельца.
 *
 * Напоминания и отчёт шлют один и тот же payload по одному и тому же набору
 * подписок с одной и той же политикой мёртвых подписок — раньше это было
 * два места с одинаковым кодом, и любая правка политики (новый статус,
 * задержка, другое правило логирования) грозила разойтись между ними молча.
 * Возвращает число реально доставленных пушей: вызывающему из напоминаний
 * нужно только «дошло хоть куда-то», а отчёту — счётчик в ответ роута.
 *
 * `label` — не для логики, а для лога: «напоминание» или «отчёт». Логи этого
 * проекта видны только потоком (`vercel logs --follow`), задним числом
 * не открыть, — и до объединения двух копий этой функции сбой напоминания
 * и сбой отчёта писали разные строки. После объединения строка стала одна
 * на оба случая, и понедельничный сбой отчёта в логе было не отличить от
 * рутинного сбоя напоминания.
 */
async function sendToAll(
  userId: string,
  subscriptions: PushSubscriptionRow[],
  payload: string,
  label: 'напоминание' | 'отчёт',
): Promise<number> {
  let delivered = 0;
  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        payload,
      );
      delivered += 1;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      // 404 и 410 означают, что подписки больше нет. Иначе мёртвые строки
      // копятся и каждый запуск тратит время на заведомо провальные запросы.
      if (status === 404 || status === 410) {
        await removeSubscription(userId, subscription.endpoint);
      } else {
        // Только код ответа: сам объект ошибки у web-push несёт endpoint
        // подписки, а он адрес и есть — в лог ему хода нет (пункт 6).
        console.error(`Не удалось отправить ${label}`, status);
      }
    }
  }
  return delivered;
}

export async function POST(request: Request) {
  if (!secretMatches(request.headers.get('x-notify-secret'))) {
    return NextResponse.json({ error: 'Не авторизован' }, { status: 401 });
  }

  // Список берётся из подписок и сверяется с белым списком: слать некому тем,
  // кто уведомления не включал, и нельзя тем, у кого отозван доступ.
  const userIds = await getNotifiableUsers();

  webpush.setVapidDetails(
    'mailto:yevhen.tuk@gmail.com',
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  );

  let sentTotal = 0;
  let dueTotal = 0;
  let subscriptionsTotal = 0;
  let reportsSentTotal = 0;
  let calendarsSyncedTotal = 0;

  for (const userId of userIds) {
    try {
      const [settings, timezone] = await Promise.all([getSettings(userId), getTimezone(userId)]);
      const { today, nowMinute } = nowInZone(timezone);

      // Завтра нужно потому, что окно перешагивает полночь: задача в 00:05
      // при напоминании за 15 минут требует отправки в 23:50 предыдущего дня.
      // getSentKeys и markSent — без владельца: их ключи (task.id либо
      // occ:<правило>:<дата>) уникальны глобально, а не в рамках человека.
      const [tasks, alreadySent, subscriptions] = await Promise.all([
        loadRange(userId, today, addDays(today, 1)),
        getSentKeys(),
        getSubscriptions(userId),
      ]);

      const due = selectDue({
        tasks,
        today,
        nowMinute,
        beforeMinutes: settings.notifyBeforeMinutes,
        alreadySent,
      });
      dueTotal += due.length;
      subscriptionsTotal += subscriptions.length;

      // Напоминания — в своей попытке. Раньше обе работы шли под одним try,
      // и детерминированный сбой здесь — например, formatTimeRange споткнулся
      // о задачу с испорченными полями времени — уносил с собой ещё и отчёт
      // ниже, хотя они ничем, кроме этого try, не связаны. Отчёт сам себя
      // лечит, стучась заново каждую минуту до местной полуночи, но только
      // если у него есть шанс вообще запуститься.
      try {
        // Встречи Google — тем же окном в двое суток, что и задачи, и по той
        // же причине: окно напоминания перешагивает полночь. Загрузка и отбор —
        // здесь же, а не в общей части выше: сбой чтения Google (запрос упал,
        // пояс кривой) не должен читаться как сбой стадии «настройка» и не
        // должен уносить с собой уже готовые к отправке due-задачи.
        const to = addDays(today, 1);
        const rawEvents = await getEventsBetween(
          userId,
          `${addDays(today, -1)}T00:00:00.000Z`,
          `${addDays(to, 1)}T00:00:00.000Z`,
        );
        const events: EventDay[] = splitIntoDays(rawEvents, timezone, today, to);
        const dueEvents = selectDueEvents({
          events,
          today,
          nowMinute,
          beforeMinutes: settings.notifyBeforeMinutes,
          alreadySent,
        });
        dueTotal += dueEvents.length;

        // Не continue: дальше по коду ждёт отчёт за неделю, и его понедельничная
        // проверка часа никак не связана с тем, есть ли прямо сейчас due-напоминания.
        if ((due.length > 0 || dueEvents.length > 0) && subscriptions.length > 0) {
          const delivered: string[] = [];

          // Порядок: сначала задачи, потом встречи — как в разделе задач выше.
          for (const task of due) {
            const payload = JSON.stringify({ ...describe(task, settings.notifyBeforeMinutes), tag: task.id });
            const count = await sendToAll(userId, subscriptions, payload, 'напоминание');
            sentTotal += count;

            // Отметку ставим, только если уведомление куда-то дошло. Иначе временный
            // сбой сети навсегда съел бы напоминание: ключ записан, повтора не будет.
            if (count > 0) delivered.push(task.id);
          }

          for (const event of dueEvents) {
            const key = eventKey(event);
            const payload = JSON.stringify({ ...describe(event, settings.notifyBeforeMinutes), tag: key });
            const count = await sendToAll(userId, subscriptions, payload, 'напоминание');
            sentTotal += count;

            if (count > 0) delivered.push(key);
          }

          // Одним вызовом на задачи и встречи: обе отметки живут в одной
          // таблице `sent` с глобально уникальными ключами.
          await markSent(delivered);
        }
      } catch {
        // Отметку при сбое не ставим: markSent мог не успеть выполниться,
        // а непопавшее в него напоминание безопаснее отправить повторно на
        // следующем запуске, чем потерять навсегда. Само исключение в лог
        // не идёт — в нём может оказаться адрес, id владельца или текст
        // задачи (пункт 6 брифа). Стадия в сообщении — чтобы этот сбой
        // не читался в логе (только потоком, `vercel logs --follow`) как
        // сбой отчёта ниже.
        console.error('notify: сбой у одного из владельцев (напоминания)');
      }

      // Отчёт — тоже в своей попытке, зеркально: если упадёт он, уже
      // отправленные выше напоминания терять незачем.
      try {
        // Понедельничный отчёт: своя проверка часа внутри, вызывается на каждом
        // прогоне, а не только когда есть due-напоминания.
        const report = await runWeeklyReport(
          { getWeekSnapshot, saveWeekSnapshot, saveReport, loadRange, getTasksByIds, getChecklistTasks },
          userId,
          today,
          nowMinute,
          settings.workStartMinute,
        );

        if (report) {
          const payload = JSON.stringify({ ...describeReport(report), url: '/report', tag: 'weekly-report' });
          reportsSentTotal += await sendToAll(userId, subscriptions, payload, 'отчёт');
        }
      } catch {
        console.error('notify: сбой у одного из владельцев (отчёт)');
      }

      // Синхронизация календаря — третья стадия, в своей попытке.
      // Сбой чтения Google не должен уносить ни напоминания, ни отчёт:
      // они уже отработали выше и к Google отношения не имеют.
      try {
        const calendarResult = await syncUser(calendarDeps, userId, today, new Date());
        calendarsSyncedTotal += calendarResult.synced;
        // Сбой отдельного календаря syncUser проглотил, чтобы не уносить
        // соседние. Но молчать о нём нельзя — иначе стадия будет выглядеть
        // успешной, ничего не синхронизировав.
        if (calendarResult.failed > 0) console.error('notify: часть календарей не синхронизирована');
      } catch {
        // Ни адреса, ни идентификатора владельца, ни названий встреч:
        // стадия и всё. Различать её в потоке логов надо по слову.
        console.error('notify: сбой у одного из владельцев (календарь)');
      }
    } catch {
      // Сбой у одного не должен оставить остальных без уведомлений — поэтому
      // try/catch внутри тела цикла, а не снаружи него. Эта попытка — только
      // на общую часть (настройки, часовой пояс, подписки): сбой внутри неё
      // случается до разделения на напоминания и отчёт, так что различать
      // стадию здесь нечем.
      console.error('notify: сбой у одного из владельцев (настройка)');
    }
  }

  try {
    // Уборка — не причина откатывать уже разосланное и отмеченное: падение
    // purgeOldSent не должно превращать удачный прогон в 500 после того, как
    // все владельцы обработаны.
    await purgeOldSent();
  } catch {
    console.error('notify: не удалось убрать старые отметки об отправке');
  }

  return NextResponse.json({
    sent: sentTotal,
    due: dueTotal,
    subscriptions: subscriptionsTotal,
    reportsSent: reportsSentTotal,
    calendarsSynced: calendarsSyncedTotal,
  });
}
