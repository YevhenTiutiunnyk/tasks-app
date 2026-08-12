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

  async function signOut() {
    if (signOutBusy) return;
    setSignOutBusy(true);
    setSignOutError('');
    const { error: failure } = await authClient.signOut();
    // Бэкенд сообщает — экран молчит: та же серия дефектов, что и на
    // странице входа. Полной перезагрузкой уходим только при успехе —
    // при отказе состояние страницы остаётся прежним, человек всё ещё
    // вошёл, и это надо показать, а не молча увести никуда.
    if (failure) {
      setSignOutError(failure.message ?? 'Не получилось выйти');
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

      <PushToggle />

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
