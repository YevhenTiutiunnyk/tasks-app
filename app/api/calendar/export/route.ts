import { NextResponse } from 'next/server';
import { disableExport, enableExport, getExport } from '@/lib/db';
import { CalendarAccessLost, CalendarGone } from '@/lib/google-api';
import { getCalendarClient } from '@/lib/google-token';
import { requireUser } from '@/lib/require-user';

/**
 * Название календаря, который заводится в Google под выгрузку. Отдельный
 * календарь, а не чужие: разрешение calendar.app.created даёт власть только
 * над тем, что создало само приложение, и до встреч человека не дотягивается.
 */
const EXPORT_CALENDAR_SUMMARY = 'Расписание';

/**
 * Состояние выгрузки. Читаем только свою базу и ни при каких условиях
 * не ходим в Google: на ступени A этот же экран не умел отличить «не
 * подключено» от «подключено, но поход в Google сорвался» — отказ съедал
 * пустой catch, человек видел нетронутый начальный экран без единой
 * подсказки, и причину искали тремя запросами в базу. Здесь ходить некуда,
 * значит и путать нечего.
 */
export async function GET(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

  const row = await getExport(user.userId);
  return NextResponse.json({
    enabled: row?.enabled ?? false,
    broken: row?.brokenAt != null,
  });
}

/**
 * Включение: завести календарь в Google и запомнить его за владельцем.
 *
 * Отказы различаются в ответе нарочно. `CalendarAccessLost` значит ровно
 * одно — разрешения на запись нет, и человеку надо пройти согласие заново;
 * общий 500 на этом месте отправил бы его чинить сеть вместо того, чтобы
 * нажать одну кнопку. Прочий отказ — 500 с общим текстом: подробности
 * ответа Google экрану не нужны, а в них бывают чужие названия.
 */
export async function POST(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

  // Повторный POST приходит сам собой: экран делает его после возврата
  // с согласия Google, а туда можно вернуться и по кнопке «назад».
  // Без этой проверки второй заход завёл бы ВТОРОЙ календарь «Расписание»,
  // и первый повис бы у человека сиротой — указателя на него у нас уже
  // не осталось бы. Сломанную выгрузку проверка нарочно пропускает: там
  // старого календаря либо нет вовсе (его удалили руками), либо мы в него
  // всё равно больше не попадём.
  const current = await getExport(user.userId);
  if (current?.enabled && current.calendarId && current.brokenAt === null) {
    return NextResponse.json({ enabled: true });
  }

  try {
    const client = await getCalendarClient(user.userId);
    const calendarId = await client.createCalendar(EXPORT_CALENDAR_SUMMARY);
    await enableExport(user.userId, calendarId);
  } catch (error) {
    if (error instanceof CalendarAccessLost) {
      // В лог — только стадия: ни адреса, ни владельца, ни названий.
      console.error('export: включение — Google не дал разрешения на запись');
      return NextResponse.json({
        error: 'Google не дал разрешение на запись. Дай его заново и повтори.',
        needsConsent: true,
      }, { status: 403 });
    }
    console.error('export: включение не удалось');
    return NextResponse.json({ error: 'Не удалось завести календарь в Google' }, { status: 500 });
  }

  return NextResponse.json({ enabled: true });
}

/**
 * Выключение: удалить календарь в Google и только потом убрать строку.
 *
 * Порядок здесь несущий. Строка — единственный наш указатель на календарь.
 * Убери её первой, и сорвись удаление в Google, — календарь «Расписание»
 * останется висеть в аккаунте навсегда, а мы о нём больше не вспомним
 * и удалить его будет нечем. Поэтому сперва Google, потом база, и никакой
 * перестановки «ради простоты».
 *
 * `CalendarGone` — не отказ: календаря и так нет, это ровно то, чего мы
 * добивались. Идём дальше и выключаем.
 */
export async function DELETE(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

  const row = await getExport(user.userId);
  // Строки нет — выключать нечего, и это не ошибка: экран мог отстать
  // от базы, а повторное нажатие не должно краснеть.
  if (!row) return NextResponse.json({ enabled: false });

  if (row.calendarId) {
    try {
      const client = await getCalendarClient(user.userId);
      await client.deleteCalendar(row.calendarId);
    } catch (error) {
      if (!(error instanceof CalendarGone)) {
        // Строку НЕ трогаем: календарь в Google жив, и она — единственное,
        // чем его ещё можно будет удалить.
        if (error instanceof CalendarAccessLost) {
          console.error('export: выключение — Google не пускает нас в календарь');
          return NextResponse.json({
            error: 'Google больше не пускает нас в календарь «Расписание», поэтому удалить его мы '
              + 'не можем. Дай разрешение заново и повтори — или удали календарь в Google руками.',
            needsConsent: true,
          }, { status: 403 });
        }
        console.error('export: календарь в Google не удалён, выгрузка оставлена включённой');
        return NextResponse.json({
          error: 'Не удалось удалить календарь «Расписание» в Google. Выгрузка осталась включённой '
            + '— попробуй ещё раз.',
        }, { status: 500 });
      }
    }
  }

  await disableExport(user.userId);
  return NextResponse.json({ enabled: false });
}
