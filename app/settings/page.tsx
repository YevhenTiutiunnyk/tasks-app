'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { clockToMinutes, minutesToClock } from '@/lib/format';
import type { Settings } from '@/lib/types';

export default function SettingsPage() {
  const router = useRouter();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [start, setStart] = useState('09:00');
  const [end, setEnd] = useState('18:00');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');

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
  if (!settings) return <main className="p-6 text-sm opacity-60">Загружаю…</main>;

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

  return (
    <main className="mx-auto max-w-md space-y-5 p-5">
      <div className="flex items-center gap-3">
        <Link href="/" className="text-sm opacity-60">← к расписанию</Link>
        <h1 className="text-lg font-semibold">Настройки</h1>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Рабочие часы</h2>
        <div className="flex items-center gap-2">
          <input
            value={start}
            onChange={(e) => setStart(e.target.value)}
            className="w-24 rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          <span className="opacity-50">—</span>
          <input
            value={end}
            onChange={(e) => setEnd(e.target.value)}
            className="w-24 rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
        </div>
        <p className="text-xs opacity-55">По ним трактуются «утром», «после работы», «вечером».</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium">Про меня</h2>
        <textarea
          value={settings.aboutMe}
          onChange={(e) => setSettings({ ...settings, aboutMe: e.target.value })}
          rows={4}
          placeholder="Встаю в 7, спортзал обычно вечером, по средам работаю из дома…"
          className="w-full rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
        <p className="text-xs opacity-55">Этот текст уходит в каждый запрос вместе с фразой.</p>
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
              className="h-7 w-9 rounded border border-neutral-500/30"
            />
            <input
              value={category.name}
              onChange={(e) => {
                const next = [...settings.categories];
                next[index] = { ...category, name: e.target.value };
                setSettings({ ...settings, categories: next });
              }}
              className="flex-1 rounded-md border border-neutral-300 px-2 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
            />
            <button
              onClick={() =>
                setSettings({
                  ...settings,
                  categories: settings.categories.filter((_, i) => i !== index),
                })
              }
              className="px-1 text-xs opacity-50"
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
          className="text-xs opacity-65"
        >
          + добавить категорию
        </button>
      </section>

      <div className="flex items-center gap-3 border-t border-neutral-500/20 pt-4">
        <button
          onClick={() => void save()}
          disabled={busy}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {busy ? '…' : 'Сохранить'}
        </button>
        {status && <span className="text-xs opacity-65">{status}</span>}
      </div>
    </main>
  );
}
