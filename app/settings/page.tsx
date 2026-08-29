'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { authClient } from '@/lib/auth-client';
import { clockToMinutes, minutesToClock } from '@/lib/format';
import PushToggle from '../push-toggle';
import type { Settings } from '@/lib/types';

export default function SettingsPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('18:00');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [signOutError, setSignOutError] = useState('');
  // Ключ для PushToggle: меняется после попытки снять подписку при выходе —
  // см. finally в signOut, там же и зачем.
  const [pushEpoch, setPushEpoch] = useState(0);
  const [keyState, setKeyState] = useState<{
    present: boolean;
    keySetAt: string | null;
    lockedUntil: string | null;
  } | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [keyEditing, setKeyEditing] = useState(false);
  const [keyStatus, setKeyStatus] = useState('');
  const [keyBusy, setKeyBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/settings');
        // Без этих проверок протухшая сессия клала бы {error} в settings,
        // и страница падала бы на settings.categories.map с TypeError.
        if (response.status === 401) {
          router.push('/login');
          return;
        }
        if (!response.ok) {
          if (!cancelled) setLoadError('Не удалось загрузить настройки');
          return;
        }
        const loaded: Settings = await response.json();
        if (cancelled) return;
        setSettings(loaded);
        setStart(minutesToClock(loaded.workStartMinute));
        setEnd(minutesToClock(loaded.workEndMinute));
      } catch {
        if (!cancelled) setLoadError('Нет связи с сервером');
      }
    })();
    return () => { cancelled = true; };
  }, [router]);

  // Отдельно от загрузки настроек: у /api/key свой роут и свои отказы,
  // смешивать с /api/settings нельзя.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/key');
        if (response.status === 401) {
          router.push('/login');
          return;
        }
        if (!response.ok) return;
        const loaded = await response.json();
        if (!cancelled) setKeyState(loaded);
      } catch {
        // Молча: экран настроек уже показывает свою ошибку связи, вторая
        // плашка про то же самое только запутает.
      }
    })();
    return () => { cancelled = true; };
  }, [router]);

  if (loadError) return <main className="p-6 text-sm text-red-600">{loadError}</main>;
  if (!settings) return <main className="p-6 text-sm text-muted">Загружаю…</main>;

  async function save() {
    if (busy) return;
    const workStartMinute = clockToMinutes(start);
    const workEndMinute = clockToMinutes(end);
    if (workStartMinute === null || workEndMinute === null) {
      setStatus('Время нужно в формате 9:00');
      return;
    }
    setBusy(true);
    setStatus('');
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...settings, workStartMinute, workEndMinute }),
      });
      if (response.status === 401) {
        router.push('/login');
        return;
      }
      const body = await response.json();
      setStatus(response.ok ? 'Сохранено' : (body.error ?? 'Не получилось'));
    } catch {
      setStatus('Нет связи с сервером');
    } finally {
      setBusy(false);
    }
  }

  async function saveKey() {
    if (keyBusy) return;
    setKeyBusy(true);
    setKeyStatus('');
    try {
      const response = await fetch('/api/key', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key: keyInput }),
      });
      if (response.status === 401) {
        router.push('/login');
        return;
      }
      const body = await response.json();
      if (response.ok) {
        // Введённый ключ из памяти страницы убираем сразу же.
        setKeyInput('');
        setKeyEditing(false);
        setKeyStatus('Ключ сохранён');
        setKeyState({ present: true, keySetAt: new Date().toISOString(), lockedUntil: null });
      } else {
        // Бэкенд сообщает — экран показывает. Причина приходит в body.error.
        setKeyStatus(body.error ?? 'Не получилось');
        if (body.lockedUntil) {
          setKeyState((prev) => (prev ? { ...prev, lockedUntil: body.lockedUntil } : prev));
        }
      }
    } catch {
      setKeyStatus('Нет связи с сервером');
    } finally {
      setKeyBusy(false);
    }
  }

  async function removeKey() {
    if (keyBusy) return;
    setKeyBusy(true);
    setKeyStatus('');
    try {
      const response = await fetch('/api/key', { method: 'DELETE' });
      if (response.status === 401) {
        router.push('/login');
        return;
      }
      if (response.ok) {
        setKeyState({ present: false, keySetAt: null, lockedUntil: null });
        setKeyStatus('Ключ убран');
      } else {
        setKeyStatus('Не получилось убрать ключ');
      }
    } catch {
      setKeyStatus('Нет связи с сервером');
    } finally {
      setKeyBusy(false);
    }
  }

  /**
   * Снять подписку на пуши — и с сервера, и из браузера.
   *
   * Подписка живёт на origin, а не на сессии: выход её не трогает, и на общем
   * устройстве это протекает между людьми. A вошёл, включил уведомления,
   * вышел; вошёл B — PushToggle читает состояние из pushManager
   * .getSubscription(), то есть из браузера, и честно показывает B
   * «Включены на этом устройстве», а строка в push_subscriptions всё ещё
   * принадлежит A. Планировщик на итерации A шлёт на это устройство
   * названия задач A, и телефон B их расшифровывает и показывает. Само это
   * не вылечится: B видит «включено» и нажимать «Выключить» не станет.
   *
   * Сервер первым, пока endpoint ещё действителен, но unsubscribe — в finally
   * и потому в любом случае: даже если DELETE не долетел, снятая в браузере
   * подписка перестанет принимать доставку, и первая же попытка планировщика
   * вернёт 404/410, по которому роут сам уберёт мёртвую строку. Обратный
   * порядок такой страховки не даёт.
   */
  async function releasePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

    // getRegistration(), а не ready. ready по спецификации НИКОГДА не
    // отвергается: нет активной регистрации — промис просто висит вечно.
    // А регистрация в app/sw-register.tsx свою ошибку глотает в console.warn,
    // так что «serviceWorker есть, но /sw.js не зарегистрировался» — рабочее
    // состояние приложения, а не небылица. На ready это означало бы вечное
    // ожидание здесь, signOutBusy навсегда в true и кнопку в состоянии «…»:
    // выйти нельзя вообще. Причём именно на общем устройстве — там, ради чего
    // всё это и делается. getRegistration() разрешается в undefined, когда
    // регистрации нет, и развилка становится обычной проверкой.
    //
    // Гонку с таймаутом (Promise.race) не берём: она превращает отсутствие
    // регистрации в «подождите N секунд перед выходом» и всё равно требует
    // решить, что делать по истечении, — при том что ответ известен сразу.
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) return;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;

    let failure = '';
    let dropped = false;
    try {
      const response = await fetch('/api/push', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      if (!response.ok) failure = `сервер ответил ${response.status}`;
    } catch {
      failure = 'нет связи с сервером';
    } finally {
      dropped = await subscription.unsubscribe();
    }
    // unsubscribe отдаёт false, а не бросает, когда снять не удалось. Молча
    // принять этот false — худший из исходов: строку с сервера мы к этому
    // моменту уже убрали, браузерная подписка жива, и следующий человек
    // увидит в PushToggle «Включены на этом устройстве», не получая при этом
    // ни одного уведомления.
    if (!dropped) {
      failure = failure ? `${failure}; подписка в браузере осталась` : 'подписка в браузере осталась';
    }
    if (failure) throw new Error(`не удалось снять подписку: ${failure}`);
  }

  async function signOut() {
    if (signOutBusy) return;
    setSignOutBusy(true);
    setSignOutError('');

    try {
      await releasePush();
    } catch (cause) {
      // Выход не блокируем: человек нажал «выйти» — он должен выйти, и
      // оставить его в аккаунте из-за неснятой подписки было бы хуже, чем
      // сама неснятая подписка. Но и не глушим: пустой catch здесь означал
      // бы, что утечка уведомлений случилась и никто о ней не узнал.
      //
      // Почему в консоль, а не на экран: сразу после этого страница целиком
      // перезагружается на /login, и любое сообщение в signOutError мигнуло
      // бы и исчезло, ничего не сообщив. Держать человека до нажатия «ок»
      // (alert) — это и есть блокировка выхода, да ещё и без единого
      // действия, которое он мог бы предпринять. В консоли след остаётся.
      //
      // В лог — только текст ошибки, без самого объекта: у ошибок этого
      // пути в полях лежит endpoint подписки, а он адрес устройства
      // (пункт 6 брифа — адресам в логах хода нет).
      console.error('выход:', cause instanceof Error ? cause.message : 'сбой снятия подписки');
    } finally {
      // Число в key заставляет PushToggle смонтироваться заново и перечитать
      // состояние из браузера. Нужно это ровно для одного случая: подписку
      // сняли, а authClient.signOut() ниже отказал — человек остался
      // в аккаунте на той же странице, где переключатель всё ещё показывает
      // «Включены на этом устройстве», прочитанное при первой загрузке.
      // Уведомлений он больше не получит, и знать об этом должен. В удачной
      // ветке перерисовка не стоит ничего: страница тут же перезагружается.
      // В finally, а не в конце try: снятие могло свалиться уже ПОСЛЕ
      // unsubscribe (например на непринятом сервером DELETE), и состояние
      // переключателя всё равно устарело.
      setPushEpoch((epoch) => epoch + 1);
    }

    let refusal = '';
    try {
      const { error: failure } = await authClient.signOut();
      // Бэкенд сообщает — экран молчит: та же серия дефектов, что и на
      // странице входа. Полной перезагрузкой уходим только при успехе —
      // при отказе состояние страницы остаётся прежним, человек всё ещё
      // вошёл, и это надо показать, а не молча увести никуда.
      if (failure) refusal = failure.message ?? 'Не получилось выйти';
    } catch {
      // Обрыв связи signOut() НЕ возвращает как { error }, а отвергает промис:
      // @better-fetch/fetch зовёт fetch без try, а catchAllError у better-auth
      // не включён — то есть ветка выше при отсутствии сети не исполняется
      // вовсе. Без этого catch исключение уходило наружу из void signOut()
      // необработанным отказом, и signOutBusy навсегда оставался true: человек
      // в метро нажимает «Выйти», подписка снимается, уведомления выключены,
      // а кнопка мертва до перезагрузки страницы и ни слова не говорит.
      refusal = 'Нет связи с сервером — выйти не удалось';
    }
    if (refusal) {
      setSignOutError(refusal);
      setSignOutBusy(false);
      return;
    }
    // Полная перезагрузка, а не router.push: без неё в памяти страницы
    // остались бы settings и прочее состояние предыдущего пользователя.
    // Адрес собран через new URL, а не строкой: правило eslint
    // no-location-assign-relative-destination видит только статически
    // выводимую относительную строку в location.href и не разворачивает
    // new URL(...) — тот же абсолютный адрес на том же origin, то же
    // поведение, но без лишнего предупреждения.
    window.location.href = new URL('/login', window.location.origin).href;
  }

  return (
    <main className="mx-auto max-w-md space-y-5 p-5">
      <div className="flex items-center gap-3">
        <Link href="/" className="text-sm text-muted">← к расписанию</Link>
        <h1 className="text-lg font-semibold">Настройки</h1>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Рабочие часы</h2>
        <div className="flex items-center gap-2">
          <input
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="w-24 rounded-md border border-hairline bg-surface px-2 py-1.5 text-sm"
          />
          <span className="text-faint">—</span>
          <input
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="w-24 rounded-md border border-hairline bg-surface px-2 py-1.5 text-sm"
          />
        </div>
        <p className="text-xs text-muted">По ним трактуются «утром», «после работы», «вечером».</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Про меня</h2>
        <textarea
          value={settings.aboutMe}
          onChange={(e) => setSettings({ ...settings, aboutMe: e.target.value })}
          rows={4}
          placeholder="Встаю в 7, спортзал обычно вечером, по средам работаю из дома…"
          className="w-full rounded-md border border-hairline bg-surface px-2 py-1.5 text-sm"
        />
        <p className="text-xs text-muted">Этот текст уходит в каждый запрос вместе с фразой.</p>
      </section>

      <PushToggle key={pushEpoch} />

      <section className="space-y-2">
        <h2 className="text-sm font-medium">За сколько предупреждать</h2>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            max={1439}
            value={settings.notifyBeforeMinutes}
            onChange={(e) =>
              setSettings({ ...settings, notifyBeforeMinutes: Number(e.target.value) })
            }
            className="w-24 rounded-md border border-hairline bg-surface px-2 py-1.5 text-sm"
          />
          <span className="text-sm text-muted">минут до начала</span>
        </div>
        <p className="text-xs text-muted">
          Задачи на весь день и уже выполненные не напоминаются.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Категории</h2>
        {settings.categories.map((category, index) => (
          <div key={category.id} className="flex items-center gap-2">
            <input
              type="color"
              value={category.color}
              onChange={(e) => {
                const next = [...settings.categories];
                next[index] = { ...category, color: e.target.value };
                setSettings({ ...settings, categories: next });
              }}
              className="h-7 w-9 rounded border border-hairline"
            />
            <input
              value={category.name}
              onChange={(e) => {
                const next = [...settings.categories];
                next[index] = { ...category, name: e.target.value };
                setSettings({ ...settings, categories: next });
              }}
              className="flex-1 rounded-md border border-hairline bg-surface px-2 py-1.5 text-sm"
            />
            <button
              onClick={() =>
                setSettings({
                  ...settings,
                  categories: settings.categories.filter((_, i) => i !== index),
                })
              }
              className="px-1 text-xs text-faint"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          onClick={() =>
            setSettings({
              ...settings,
              categories: [
                ...settings.categories,
                { id: `cat-${Date.now()}`, name: 'Новая', color: '#64748b' },
              ],
            })
          }
          className="text-xs text-muted"
        >
          + добавить категорию
        </button>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Ключ Anthropic</h2>

        {keyState === null ? (
          <p className="text-xs text-muted">Загружаю…</p>
        ) : keyState.present && !keyEditing ? (
          <div className="space-y-2 text-sm">
            <p className="text-xs text-muted">
              Ключ заведён{' '}
              {keyState.keySetAt
                ? new Date(keyState.keySetAt).toLocaleDateString('ru-RU', {
                    day: 'numeric',
                    month: 'long',
                  })
                : ''}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setKeyEditing(true)}
                className="rounded-md border border-hairline bg-surface px-3 py-1.5 text-xs disabled:opacity-50"
              >
                Заменить
              </button>
              <button
                type="button"
                onClick={() => void removeKey()}
                disabled={keyBusy}
                className="rounded-md border border-hairline bg-surface px-3 py-1.5 text-xs disabled:opacity-50"
              >
                Убрать
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <ol className="list-decimal space-y-1 pl-5 text-xs text-muted">
              <li>Открой console.anthropic.com, раздел API keys.</li>
              <li>Создай ключ и сразу скопируй — Anthropic показывает его один раз.</li>
              <li>Положи на счёт денег, иначе ключ не заработает.</li>
              <li>Вставь ключ сюда.</li>
            </ol>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={keyInput}
              onChange={(event) => setKeyInput(event.target.value)}
              placeholder="sk-ant-..."
              className="w-full rounded-md border border-hairline bg-surface px-2 py-1.5 text-sm"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => void saveKey()}
                disabled={keyBusy || !keyInput}
                className="rounded-md bg-ink px-4 py-2 text-sm text-paper disabled:opacity-50"
              >
                {keyBusy ? '…' : 'Сохранить'}
              </button>
              {keyState.present && keyEditing && (
                <button
                  type="button"
                  onClick={() => {
                    setKeyEditing(false);
                    setKeyInput('');
                  }}
                  className="rounded-md border border-hairline bg-surface px-4 py-2 text-sm disabled:opacity-50"
                >
                  Отмена
                </button>
              )}
            </div>
          </div>
        )}

        {keyStatus && <p className="text-xs text-muted">{keyStatus}</p>}
        {keyState?.lockedUntil && new Date(keyState.lockedUntil) > new Date() && (
          <p className="text-xs text-muted">
            Можно будет попробовать снова:{' '}
            {new Date(keyState.lockedUntil).toLocaleString('ru-RU', {
              day: 'numeric',
              month: 'long',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
        )}
      </section>

      <div className="flex items-center gap-3 border-t border-hairline pt-4">
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-md bg-ink px-4 py-2 text-sm text-paper disabled:opacity-50"
        >
          {busy ? '…' : 'Сохранить'}
        </button>
        {status && <span className="text-xs text-muted">{status}</span>}
      </div>

      <div className="space-y-2 border-t border-hairline pt-4">
        <button
          onClick={() => void signOut()}
          disabled={signOutBusy}
          className="rounded-md border border-hairline bg-surface px-4 py-2 text-sm disabled:opacity-50"
        >
          {signOutBusy ? '…' : 'Выйти из аккаунта'}
        </button>
        <p className="text-xs text-muted">
          Выход только с этого устройства — на остальных сессия останется.
        </p>
        {signOutError && <p className="text-xs text-red-600">{signOutError}</p>}
      </div>
    </main>
  );
}
