'use client';

import { useState } from 'react';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (response.ok) {
      window.location.href = '/';
      return;
    }
    const body = await response.json();
    setError(body.error ?? 'Не получилось войти');
    setBusy(false);
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <form onSubmit={submit} className="w-full max-w-xs space-y-3">
        <h1 className="mb-5 text-2xl font-semibold tracking-[-0.02em]">Расписание</h1>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Пароль"
          autoFocus
          className="w-full rounded-full border border-hairline bg-surface px-4 py-2.5 text-[15px] placeholder:text-faint focus:border-ink focus:outline-none"
        />
        {error && <p className="text-[13px] text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={busy || !password}
          className="w-full rounded-full bg-ink px-4 py-2.5 text-[15px] font-medium text-paper disabled:opacity-30"
        >
          Войти
        </button>
      </form>
    </main>
  );
}
