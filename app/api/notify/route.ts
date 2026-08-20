import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import webpush from 'web-push';
import {
  getSentKeys,
  getSettings,
  getSubscriptions,
  getUsersWithSubscriptions,
  markSent,
  purgeOldSent,
  removeSubscription,
} from '@/lib/db';
import { formatTimeRange } from '@/lib/format';
import { nowInZone, selectDue } from '@/lib/notify';
import { getTimezone } from '@/lib/db';
import { addDays } from '@/lib/dates';
import { loadRange } from '@/lib/week';
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

export async function POST(request: Request) {
  if (!secretMatches(request.headers.get('x-notify-secret'))) {
    return NextResponse.json({ error: 'Не авторизован' }, { status: 401 });
  }

  // Список берётся из подписок: слать некому тем, кто уведомления не включал.
  const userIds = await getUsersWithSubscriptions();

  webpush.setVapidDetails(
    'mailto:yevhen.tuk@gmail.com',
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  );

  let sentTotal = 0;
  let dueTotal = 0;
  let subscriptionsTotal = 0;

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

      if (due.length === 0 || subscriptions.length === 0) continue;

      const delivered: string[] = [];

      for (const task of due) {
        const payload = JSON.stringify({ ...describe(task, settings.notifyBeforeMinutes), tag: task.id });
        let anyDelivered = false;

        for (const subscription of subscriptions) {
          try {
            await webpush.sendNotification(
              {
                endpoint: subscription.endpoint,
                keys: { p256dh: subscription.p256dh, auth: subscription.auth },
              },
              payload,
            );
            sentTotal += 1;
            anyDelivered = true;
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

        // Отметку ставим, только если уведомление куда-то дошло. Иначе временный
        // сбой сети навсегда съел бы напоминание: ключ записан, повтора не будет.
        if (anyDelivered) delivered.push(task.id);
      }

      await markSent(delivered);
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

  await purgeOldSent();

  return NextResponse.json({ sent: sentTotal, due: dueTotal, subscriptions: subscriptionsTotal });
}
