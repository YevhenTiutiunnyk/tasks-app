'use client';

import { useEffect, useState } from 'react';
import { authClient } from '@/lib/auth-client';

// Просим ровно одно разрешение — на чтение. Прав на запись это приложение
// не запрашивает ни при каких условиях.
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

interface CalendarItem {
  calendarId: string;
  summary: string;
  selected: boolean;
}

/** Секция настроек: подключение Google Calendar и выбор календарей галочками. */
export default function GoogleCalendarSection() {
  const [items, setItems] = useState<CalendarItem[] | null>(null);
  const [broken, setBroken] = useState(false);
  const [failed, setFailed] = useState(false);
  // Кнопка «Повторить» и отключение двигают этот счётчик, и загрузка идёт
  // заново — тот же приём, что у keyReloadToken в app/settings/page.tsx.
  const [reloadToken, setReloadToken] = useState(0);

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

  const connected = (items?.length ?? 0) > 0;

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">Google Calendar</h2>

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
              className="flex h-11 shrink-0 touch-manipulation items-center rounded-lg border border-hairline bg-surface px-4 text-[13px] text-ink hover:bg-hairline active:bg-hairline"
            >
              {connected ? 'Подключить заново' : 'Подключить'}
            </button>
            {connected && (
              <button
                type="button"
                onClick={() => void disconnect()}
                className="flex h-11 shrink-0 touch-manipulation items-center rounded-lg border border-hairline bg-surface px-4 text-[13px] text-ink hover:bg-hairline active:bg-hairline"
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
            синхронизацию, но не отзывает разрешение у Google — оно одно и то
            же со входом, и его отзыв закрыл бы вход в приложение. Отозвать
            доступ можно только в настройках аккаунта Google.
          </p>
        </>
      )}
    </section>
  );
}
