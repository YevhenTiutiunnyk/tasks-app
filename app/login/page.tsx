'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { authClient } from '@/lib/auth-client';
import { EMAIL_NOT_ALLOWED_ERROR_CODE } from '@/lib/auth-error-codes';

// Незнакомые коды (их отдаёт сам better-auth: invalid_code,
// oauth_provider_not_found и т.п.) получают общую фразу — той же, что и
// раньше при неудаче signIn.social. Свой код показываем отдельно и
// специально: без подробностей о том, кто есть в белом списке.
function messageForErrorCode(code: string | null): string {
  if (!code) return '';
  if (code === EMAIL_NOT_ALLOWED_ERROR_CODE) return 'Вход не разрешён';
  return 'Не получилось войти';
}

function LoginForm() {
  const searchParams = useSearchParams();
  // Отказ в lib/auth.ts (databaseHooks.session.create.before) уводит сюда же
  // через onAPIError.errorURL и кладёт причину в ?error=. Без чтения этого
  // параметра отказ был бы виден только в сыром JSON на самом
  // /api/auth/callback/google.
  const [error, setError] = useState(() => messageForErrorCode(searchParams.get('error')));
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

export default function LoginPage() {
  // useSearchParams требует границы Suspense при статической сборке — иначе
  // `next build` падает, потому что страница входа иначе полностью
  // статическая (см. node_modules/next/dist/docs про useSearchParams).
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
