'use client';

import { useEffect, useState } from 'react';
import { authClient } from '@/lib/auth-client';

// Чтение чужих календарей. Просится при подключении и ничего больше
// не разрешает.
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

// Запись — отдельное разрешение и отдельное согласие, спрашивается только
// в половине про выгрузку. Оно даёт власть ровно над теми календарями,
// которые завело само приложение, и до встреч человека не дотягивается
// технически. Полного доступа на запись (calendar, calendar.events) здесь
// не просят ни при каких условиях.
const EXPORT_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';

// Метка «ушли за согласием на запись». Google возвращает человека на
// /settings, и по ней экран понимает, что делать дальше: без этого шага
// человек увидел бы «согласие дано», а календаря бы не было.
// sessionStorage, а не состояние: между уходом и возвратом страница
// полностью перезагружается.
const EXPORT_PENDING_KEY = 'google-export-pending';

// В метке лежит НАМЕРЕНИЕ, а не просто факт ухода. Находка ревью: пока
// метка была одна на всех, согласие, взятое ради неудавшегося выключения,
// возвращалось запросом на включение — заводился второй календарь, а первый,
// живой, оставался в Google без указателя навсегда. Человек при этом нажал
// «Выключить» и «Дать разрешение заново» и не просил ничего создавать.
const EXPORT_INTENT_ENABLE = 'enable';
const EXPORT_INTENT_DISABLE = 'disable';

// Кнопки везде в проекте одинаковые. Константа модульная, а не в теле
// компонента: строка не зависит от состояния и пересобираться на каждый
// рендер ей незачем.
const BUTTON_CLASS = 'flex h-11 shrink-0 touch-manipulation items-center rounded-lg border '
  + 'border-hairline bg-surface px-4 text-[13px] text-ink hover:bg-hairline active:bg-hairline '
  + 'disabled:opacity-50';

/**
 * Что делает нажатие на выключение выгрузки: первое — только взводит
 * подтверждение, второе — удаляет. Два шага здесь потому, что одно касание
 * — слишком мало для удаления целого календаря со всеми событиями, тем
 * более что рядом стоит почти так же названное и совершенно безобидное
 * «Отключить» (решение владельца).
 *
 * Приём взят у удаления задачи (components/TaskCard.tsx): намерение живёт
 * в состоянии, второй шаг — отдельное осознанное нажатие, и рядом всегда
 * есть «Отмена». Диалога здесь нет нарочно: половина настроек — не карточка
 * поверх экрана, и заводить второй способ задать один и тот же вопрос
 * незачем.
 *
 * Вынесено из разметки и экспортировано ради теста: главное свойство —
 * «одно нажатие ничего не удаляет» — обязано проверяться прогоном, а не
 * чтением JSX глазами. Рендерить компонент в тестах нечем (jsdom в проекте
 * нет и заводить его ради одной кнопки не станем), а эта функция и есть
 * весь двухшаговый механизм целиком.
 */
export function pressExportOff(
  armed: boolean,
  setArmed: (next: boolean) => void,
  turnOff: () => void,
): void {
  if (!armed) {
    setArmed(true);
    return;
  }
  setArmed(false);
  turnOff();
}

interface CalendarItem {
  calendarId: string;
  summary: string;
  selected: boolean;
}

/**
 * Секция настроек Google Calendar. Две половины с противоположным
 * поведением: верхняя только читает чужие календари, нижняя заводит и
 * удаляет наш собственный. Разрешения у них тоже разные и просятся порознь.
 */
export default function GoogleCalendarSection() {
  const [items, setItems] = useState<CalendarItem[] | null>(null);
  const [broken, setBroken] = useState(false);
  const [failed, setFailed] = useState(false);
  // Кнопка «Повторить» и отключение двигают этот счётчик, и загрузка идёт
  // заново — тот же приём, что у keyReloadToken в app/settings/page.tsx.
  const [reloadToken, setReloadToken] = useState(0);

  // Вторая половина секции — выгрузка. Своё состояние, своя загрузка и свой
  // отказ: чтение и запись — разные разрешения и разные роуты, и сбой одного
  // не должен гасить другое.
  const [exportState, setExportState] = useState<{ enabled: boolean; broken: boolean } | null>(null);
  const [exportError, setExportError] = useState('');
  // Роут отличает «нет разрешения» от прочих сбоев, и только в первом случае
  // человеку есть что нажать — поэтому кнопка согласия появляется по флагу,
  // а не висит всегда.
  const [exportNeedsConsent, setExportNeedsConsent] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportReloadToken, setExportReloadToken] = useState(0);
  // Взведённое подтверждение выключения — см. pressExportOff выше.
  const [exportOffArmed, setExportOffArmed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/calendar');
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (cancelled) return;
        setFailed(false);
        setItems(data.calendars);
        setBroken(data.broken);
      } catch {
        // Неудачная загрузка списка ничего не говорит о том, можно ли
        // подключиться: GET и подключение — разные операции. Прежний список
        // (если он был) оставляем как есть, чтобы кнопки «Подключить заново» /
        // «Отключить» не пропадали из-за временного сбоя сети; при самой
        // первой загрузке items ещё null, и ниже он станет пустым списком —
        // это и есть состояние «пока не подключено».
        if (!cancelled) {
          setFailed(true);
          setItems((prev) => prev ?? []);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [reloadToken]);

  // Состояние выгрузки берётся только из нашей базы — роут в Google за ним
  // не ходит. Поэтому «не включено» здесь всегда значит «не включено»,
  // а не «не смогли спросить».
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/calendar/export');
        if (!response.ok) throw new Error();
        const data = await response.json();
        if (cancelled) return;
        setExportState({ enabled: data.enabled, broken: data.broken });
      } catch {
        if (!cancelled) {
          setExportError('Не удалось узнать, включена ли выгрузка.');
          setExportState((prev) => prev ?? { enabled: false, broken: false });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [exportReloadToken]);

  // Уход со страницы снимает взведённое подтверждение. Обычный переход
  // размонтирует секцию и обнулит состояние сам, но «назад» в браузере
  // возвращает страницу целиком из кэша вместе со всем состоянием — и
  // человек обнаружил бы кнопку, уже готовую удалять, не помня, что её
  // взводил. pagehide срабатывает в обоих случаях.
  useEffect(() => {
    const disarm = () => setExportOffArmed(false);
    window.addEventListener('pagehide', disarm);
    return () => window.removeEventListener('pagehide', disarm);
  }, []);

  // Возврат с согласия Google. Само согласие ничего не создаёт и ничего
  // не удаляет — это делает запрос отсюда, и только он.
  //
  // Запрос — тот, за которым человек и уходил за разрешением: шёл включать —
  // POST, шёл выключать (кнопка «Дать разрешение заново» появляется как раз
  // после неудавшегося выключения) — снова DELETE. Пока намерения не было,
  // возврат всегда означал POST, и попытка ВЫКЛЮЧИТЬ заканчивалась вторым
  // созданным календарём и включённой выгрузкой.
  useEffect(() => {
    const intent = sessionStorage.getItem(EXPORT_PENDING_KEY);
    if (intent !== EXPORT_INTENT_ENABLE && intent !== EXPORT_INTENT_DISABLE) return;
    // Метку снимаем ДО запроса: иначе неудача повторялась бы при каждом
    // открытии настроек.
    sessionStorage.removeItem(EXPORT_PENDING_KEY);
    const method = intent === EXPORT_INTENT_ENABLE ? 'POST' : 'DELETE';

    let cancelled = false;
    void (async () => {
      // Внутри асинхронного тела, а не рядом с ним: синхронный setState
      // в теле эффекта запрещён правилом react-hooks/set-state-in-effect.
      setExportBusy(true);
      try {
        const response = await fetch('/api/calendar/export', { method });
        const data = await response.json().catch(() => null);
        if (cancelled) return;
        if (response.ok) {
          setExportError('');
          setExportNeedsConsent(false);
        } else {
          // Текст отказа даёт роут: он один знает, разрешения не хватило
          // или Google сорвался по другой причине.
          setExportError(data?.error
            ?? (method === 'POST' ? 'Не удалось включить выгрузку.' : 'Не удалось выключить выгрузку.'));
          setExportNeedsConsent(data?.needsConsent === true);
        }
      } catch {
        if (!cancelled) setExportError('Нет связи с сервером.');
      } finally {
        if (!cancelled) {
          setExportBusy(false);
          setExportReloadToken((token) => token + 1);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function connect() {
    // callbackURL возвращает на эту же страницу — иначе после согласия
    // Google человек оказался бы неизвестно где.
    await authClient.linkSocial({
      provider: 'google',
      scopes: [CALENDAR_SCOPE],
      callbackURL: '/settings',
    });
  }

  async function toggle(calendarId: string) {
    const next = (items ?? []).map((item) =>
      item.calendarId === calendarId ? { ...item, selected: !item.selected } : item,
    );
    setItems(next);
    await fetch('/api/calendar', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        calendarIds: next.filter((item) => item.selected).map((item) => item.calendarId),
      }),
    });
  }

  async function disconnect() {
    await fetch('/api/calendar', { method: 'DELETE' });
    setReloadToken((token) => token + 1);
  }

  /**
   * Согласие на запись. Само действие произойдёт уже после возврата — по
   * метке, и метка помнит, за чем человек шёл.
   */
  async function askExportConsent(intent: string) {
    sessionStorage.setItem(EXPORT_PENDING_KEY, intent);
    try {
      await authClient.linkSocial({
        provider: 'google',
        scopes: [EXPORT_SCOPE],
        callbackURL: '/settings',
      });
    } catch {
      // Уйти не вышло — значит и возврата не будет. Метку надо снять:
      // иначе она дождалась бы СЛЕДУЮЩЕГО, ничем не связанного захода
      // в настройки и завела бы календарь, которого в тот раз никто
      // не просил.
      sessionStorage.removeItem(EXPORT_PENDING_KEY);
      setExportError('Не удалось открыть согласие Google. Попробуй ещё раз.');
    }
  }

  async function turnExportOff() {
    setExportBusy(true);
    setExportError('');
    setExportNeedsConsent(false);
    try {
      const response = await fetch('/api/calendar/export', { method: 'DELETE' });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setExportError(data?.error ?? 'Не удалось выключить выгрузку.');
        setExportNeedsConsent(data?.needsConsent === true);
      }
    } catch {
      setExportError('Нет связи с сервером.');
    } finally {
      setExportBusy(false);
      setExportReloadToken((token) => token + 1);
    }
  }

  const connected = (items?.length ?? 0) > 0;

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">Google Calendar</h2>

      {/*
        Заголовок у каждой половины свой. Половины делают противоположные
        вещи — одна только читает чужое, другая заводит и удаляет своё, —
        и без подписи человек принял бы их за одну настройку с двумя
        кнопками.
      */}
      <h3 className="text-[13px] font-medium text-muted">Показывать встречи из Google</h3>

      {items === null ? (
        <p className="text-xs text-muted">Загружаю…</p>
      ) : (
        <>
          {failed && (
            <div className="space-y-2">
              <p className="text-xs text-red-600">Не удалось получить список календарей.</p>
              <button
                type="button"
                onClick={() => setReloadToken((token) => token + 1)}
                className="rounded-md border border-hairline bg-surface px-3 py-1.5 text-xs"
              >
                Повторить
              </button>
            </div>
          )}

          {broken && (
            <p className="text-xs text-red-600">
              Подключение потеряно — Google больше не пускает нас в календарь.
              Нажми «Подключить заново», чтобы восстановить.
            </p>
          )}

          {!connected && !failed && (
            <p className="text-xs text-muted">
              Встречи из Google появятся в расписании и будут учтены при надиктовке.
            </p>
          )}

          {items.length > 0 && (
            <ul className="space-y-1">
              {items.map((item) => (
                <li key={item.calendarId}>
                  <label className="flex h-11 items-center gap-3 touch-manipulation text-sm">
                    <input
                      type="checkbox"
                      checked={item.selected}
                      onChange={() => void toggle(item.calendarId)}
                    />
                    <span>{item.summary}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void connect()}
              className={BUTTON_CLASS}
            >
              {connected ? 'Подключить заново' : 'Подключить'}
            </button>
            {connected && (
              <button
                type="button"
                onClick={() => void disconnect()}
                className={BUTTON_CLASS}
              >
                Отключить
              </button>
            )}
          </div>

          {/*
            Здесь и только здесь: согласие на вход и на календарь — одно и то
            же в Google. Отзови мы его при отключении, человек потерял бы
            возможность войти в приложение. Поэтому «Отключить» стирает
            только нашу копию и останавливает синхронизацию, а согласие
            остаётся у Google до тех пор, пока его не отзовут в настройках
            аккаунта Google.
          */}
          <p className="text-xs text-muted">
            «Отключить» убирает копию календаря из приложения и останавливает
            синхронизацию, но в самом Google ничего не меняет: встречи и
            календари остаются на месте, мы их не трогаем. Разрешение у Google
            тоже не отзывается — оно одно и то же со входом, и его отзыв закрыл
            бы вход в приложение. Отозвать доступ можно только в настройках
            аккаунта Google.
          </p>
        </>
      )}

      <div className="space-y-2 border-t border-hairline pt-3">
        <h3 className="text-[13px] font-medium text-muted">Выгружать мои задачи в Google</h3>

        {exportState === null ? (
          <p className="text-xs text-muted">Загружаю…</p>
        ) : (
          <>
            {exportError && <p className="text-xs text-red-600">{exportError}</p>}

            {exportState.broken && (
              <p className="text-xs text-red-600">
                Выгрузка остановлена: Google больше не пускает нас в календарь
                «Расписание». Нажми «Выключить», а потом «Включить» снова — старый
                календарь уберём, новый заведём. Если Google не даст его удалить,
                рядом появится кнопка «Дать разрешение заново».
              </p>
            )}

            {!exportState.enabled && (
              <p className="text-xs text-muted">
                Заведём в Google отдельный календарь «Расписание» и будем держать
                в нём твои задачи. Разрешение спросим отдельное — только на
                календари, созданные этим приложением: до остальных твоих встреч
                оно доступа не даёт.
              </p>
            )}

            {/*
              Вопрос задаётся ровно теми же словами, что и подпись под
              кнопкой, — «насовсем» здесь несёт всю нагрузку: без него
              «удалим» читается как «перестанем показывать».
            */}
            {exportState.enabled && exportOffArmed && (
              <p className="text-xs text-muted">
                Сейчас удалим календарь «Расписание» из Google вместе со всеми
                выгруженными в него задачами. Это насовсем, вернуть их оттуда
                будет нечем.
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              {exportState.enabled ? (
                // Взведённое подтверждение ставит на место «Выключить»
                // ОТМЕНУ, а удаление уводит вправо. Случайное второе касание
                // в то же место должно отменять, а не удалять.
                exportOffArmed ? (
                  <>
                    <button
                      type="button"
                      disabled={exportBusy}
                      onClick={() => setExportOffArmed(false)}
                      className={BUTTON_CLASS}
                    >
                      Отмена
                    </button>
                    <button
                      type="button"
                      disabled={exportBusy}
                      onClick={() =>
                        pressExportOff(exportOffArmed, setExportOffArmed, () => void turnExportOff())}
                      className={BUTTON_CLASS}
                    >
                      Удалить насовсем
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={exportBusy}
                    onClick={() =>
                      pressExportOff(exportOffArmed, setExportOffArmed, () => void turnExportOff())}
                    className={BUTTON_CLASS}
                  >
                    Выключить
                  </button>
                )
              ) : (
                <button
                  type="button"
                  disabled={exportBusy}
                  onClick={() => void askExportConsent(EXPORT_INTENT_ENABLE)}
                  className={BUTTON_CLASS}
                >
                  Включить
                </button>
              )}
              {/*
                Только при включённой выгрузке. В выключенном состоянии эта
                кнопка встала бы рядом с «Включить», выглядела бы так же
                и делала бы то же самое — две кнопки на одно действие
                (и самый широкий ряд на экране в 375 пикселей). А здесь
                делать ей есть что: «Выключить» упёрлось в отозванное
                разрешение, и после согласия выключение повторится само.
              */}
              {exportNeedsConsent && exportState.enabled && !exportOffArmed && (
                <button
                  type="button"
                  disabled={exportBusy}
                  onClick={() => void askExportConsent(EXPORT_INTENT_DISABLE)}
                  className={BUTTON_CLASS}
                >
                  Дать разрешение заново
                </button>
              )}
            </div>

            {/*
              Эта половина ведёт себя ПРОТИВОПОЛОЖНО верхней, и об этом надо
              сказать вслух под самой кнопкой. Наверху «Отключить» не меняет
              в Google ничего; здесь «Выключить» удаляет там целый календарь
              вместе со всем, что мы в него выгрузили. Не напиши мы разницу
              прямо здесь, человек решил бы, что одна из подписей врёт.
            */}
            {exportState.enabled && (
              <p className="text-xs text-muted">
                «Выключить» удаляет календарь «Расписание» в Google целиком —
                вместе со всеми выгруженными в него задачами. Это насовсем,
                вернуть их оттуда будет нечем. Других календарей и встреч это
                не касается: мы удаляем только тот календарь, который завели
                сами.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
