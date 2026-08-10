import { toNextJsHandler } from 'better-auth/next-js';
import { auth } from '@/lib/auth';

// Catch-all: Better Auth поднимает здесь и начало входа, и колбэк от Google,
// и выход, и чтение сессии. Отсюда же требование к матчеру в proxy.ts —
// исключение api/auth/ со слешем, см. задачу 5.
export const { GET, POST } = toNextJsHandler(auth);
