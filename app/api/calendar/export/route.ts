import { NextResponse } from 'next/server';
import { disableExport, enableExport, getExport, saveExportState } from '@/lib/db';
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
  // не осталось бы.
  //
  // Сломанная выгрузка проверку НЕ обходит, хотя соблазн есть: broken_at
  // ставится и на CalendarAccessLost (lib/export-run.ts), а это значит
  // «мы не можем в календарь», а вовсе не «календаря нет». Обойди мы
  // проверку здесь, повторное включение после потери доступа завело бы
  // новый календарь и перенацелило бы calendar_id — и живое первое
  // «Расписание» осталось бы в Google навсегда без единого указателя
  // с нашей стороны. Ровно та беда, ради которой в DELETE задан порядок,
  // только через парадную дверь (находка ревью). Выход из сломанного
  // состояния один и он же правильный: сперва «Выключить» (оно терпит
  // CalendarGone и потому срабатывает и когда календарь удалили руками),
  // и только потом «Включить» заново.
  const current = await getExport(user.userId);
  if (current?.enabled && current.calendarId) {
    return NextResponse.json({ enabled: true });
  }

  let calendarId: string;
  try {
    const client = await getCalendarClient(user.userId);
    calendarId = await client.createCalendar(EXPORT_CALENDAR_SUMMARY);
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

  // Отдельный try, и вот почему. Календарь в Google уже создан, а строки
  // с указателем на него ещё нет. Скажи мы здесь «не удалось завести
  // календарь» (а до находки ревью оба шага сидели в одном catch и отвечали
  // именно так), человек никогда не пошёл бы искать сироту — мы бы сами
  // уверили его, что искать нечего. Компенсирующее удаление не делаем:
  // это второй поход в Google на пути отказа, со своим отказом. Но врать
  // про то, чего мы не знаем, нельзя.
  try {
    await enableExport(user.userId, calendarId);
  } catch {
    console.error('export: календарь заведён, но выгрузка не включилась');
    return NextResponse.json({
      error: 'Календарь «Расписание» в Google, похоже, уже заведён, а включить выгрузку не вышло. '
        + 'Загляни в Google: если он там появился, удали его руками и попробуй снова.',
    }, { status: 500 });
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
        // ВНИМАНИЕ, ЭТО ОДНО ИЗМЕНЕНИЕ, А НЕ ДВА. Оставлять строку при
        // потере доступа безопасно ровно потому, что на экране есть кнопка
        // «Дать разрешение заново» (app/settings/google-calendar.tsx),
        // и после согласия она ПОВТОРЯЕТ это самое выключение. Убери её —
        // и человек застрянет: выключить нельзя (Google не пускает),
        // а позвать согласие в состоянии «включено» больше нечем. Тогда
        // здесь придётся решать заново, что делать с указателем.
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

/**
 * Неразрушающий выход из «связь сломана» — находка I3 финального ревью.
 *
 * До этой правки единственным лечением `broken_at` было «Выключить», потом
 * «Включить» — удаление календаря «Расписание» в Google целиком и выгрузка
 * всех задач заново. Ту же пометку ставит и настоящая потеря доступа,
 * и превышение лимита запросов у Google (403 на оба, см. lib/google-api.ts):
 * временную заминку чинили сносом всего, что накопилось.
 *
 * PATCH в Google не ходит вовсе и связки не трогает — только снимает
 * пометку. Если причиной была не заминка, а настоящая потеря доступа,
 * следующий тик планировщика получит тот же 401/403 и пометит связь
 * сломанной заново; разрушительный путь остаётся доступен, просто не
 * единственным и не первым.
 */
export async function PATCH(request: Request) {
  const user = await requireUser(request);
  if (user.response) return user.response;

  await saveExportState(user.userId, { brokenAt: null });
  const row = await getExport(user.userId);
  return NextResponse.json({ enabled: row?.enabled ?? false, broken: row?.brokenAt != null });
}
