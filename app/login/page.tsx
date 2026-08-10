'use client';

import { useState } from 'react';
import { authClient } from '@/lib/auth-client';

export default function LoginPage() {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function signIn() {
    setBusy(true);
    setError('');
    const { error: failure } = await authClient.signIn.social({
      provider: 'google',
      callbackURL: '/',
    });
    // Бэкенд сообщает — экран молчит: девять дефектов подряд этого вида уже
    // были в этом проекте. Причину показываем.
    if (failure) {
      setError(failure.message ?? 'Не получилось войти');
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-xs space-y-3">
        <h1 className="mb-5 text-2xl font-semibold tracking-[-0.02em]">Расписание</h1>
        {error && <p className="text-[13px] text-red-600">{error}</p>}
        <button
          type="button"
          onClick={signIn}
          disabled={busy}
          className="w-full rounded-full bg-ink px-4 py-2.5 text-[15px] font-medium text-paper disabled:opacity-30"
        >
          Войти через Google
        </button>
      </div>
    </main>
  );
}
