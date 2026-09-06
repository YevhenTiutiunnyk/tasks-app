import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import webpush from 'web-push';
import {
  getChecklistTasks,
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
import { nowInZone, selectDue } from '@/lib/notify';
import { getTimezone } from '@/lib/db';
import { addDays } from '@/lib/dates';
import { loadRange } from '@/lib/week';
import { runWeeklyReport } from '@/lib/report-run';
import { describeReport } from '@/lib/report';
import type { Task } from '@/lib/types';

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

function describe(task: Task, beforeMinutes: number): { title: string; body: string } {
  const when = task.startMinute === null
    ? ''
    : ` · ${formatTimeRange(task.startMinute, task.durationMinutes)}`;
  return {
    title: task.title,
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
 */
async function sendToAll(
  userId: string,
  subscriptions: PushSubscriptionRow[],
  payload: string,
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
        console.error('Не удалось отправить уведомление', status);
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

      // Не continue: дальше по коду ждёт отчёт за неделю, и его понедельничная
      // проверка часа никак не связана с тем, есть ли прямо сейчас due-напоминания.
      if (due.length > 0 && subscriptions.length > 0) {
        const delivered: string[] = [];

        for (const task of due) {
          const payload = JSON.stringify({ ...describe(task, settings.notifyBeforeMinutes), tag: task.id });
          const count = await sendToAll(userId, subscriptions, payload);
          sentTotal += count;

          // Отметку ставим, только если уведомление куда-то дошло. Иначе временный
          // сбой сети навсегда съел бы напоминание: ключ записан, повтора не будет.
          if (count > 0) delivered.push(task.id);
        }

        await markSent(delivered);
      }

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
        reportsSentTotal += await sendToAll(userId, subscriptions, payload);
      }
    } catch {
      // Сбой у одного не должен оставить остальных без уведомлений — поэтому
      // try/catch внутри тела цикла, а не снаружи него. Отметку при сбое
      // не ставим: markSent мог не успеть выполниться, а непопавшее в него
      // напоминание безопаснее отправить повторно на следующем запуске, чем
      // потерять навсегда. Само исключение в лог не идёт — в нём может
      // оказаться адрес, id владельца или текст задачи (пункт 6 брифа).
      console.error('notify: сбой у одного из владельцев');
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
  });
}
