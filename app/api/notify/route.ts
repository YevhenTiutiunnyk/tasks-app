import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import webpush from 'web-push';
import {
  getSentKeys,
  getSettings,
  getSoleUserId,
  getSubscriptions,
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

  // Сессии у планировщика нет и быть не может, а владелец нужен: до задачи 5
  // роут работает на единственном. Если их уже не один, лучше не отправить
  // ничего, чем разослать одному человеку чужие напоминания.
  const userId = await getSoleUserId();
  if (!userId) {
    return NextResponse.json({ sent: 0, due: 0, subscriptions: 0, reason: 'не один владелец' });
  }

  const [settings, timezone] = await Promise.all([getSettings(userId), getTimezone(userId)]);
  const { today, nowMinute } = nowInZone(timezone);

  // Завтра нужно потому, что окно перешагивает полночь: задача в 00:05
  // при напоминании за 15 минут требует отправки в 23:50 предыдущего дня.
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

  if (due.length === 0 || subscriptions.length === 0) {
    await purgeOldSent();
    return NextResponse.json({ sent: 0, due: due.length, subscriptions: subscriptions.length });
  }

  webpush.setVapidDetails(
    'mailto:yevhen.tuk@gmail.com',
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY!,
    process.env.VAPID_PRIVATE_KEY!,
  );

  let sent = 0;
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
        sent += 1;
        anyDelivered = true;
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        // 404 и 410 означают, что подписки больше нет. Иначе мёртвые строки
        // копятся и каждый запуск тратит время на заведомо провальные запросы.
        if (status === 404 || status === 410) {
          await removeSubscription(userId, subscription.endpoint);
        } else {
          console.error('Не удалось отправить уведомление', status, error);
        }
      }
    }

    // Отметку ставим, только если уведомление куда-то дошло. Иначе временный
    // сбой сети навсегда съел бы напоминание: ключ записан, повтора не будет.
    if (anyDelivered) delivered.push(task.id);
  }

  await markSent(delivered);
  await purgeOldSent();

  return NextResponse.json({ sent, due: due.length, subscriptions: subscriptions.length });
}
