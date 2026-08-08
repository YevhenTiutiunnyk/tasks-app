import { NextResponse, type NextRequest } from 'next/server';
import { verifySession } from '@/lib/auth';

export async function middleware(request: NextRequest) {
  const token = request.cookies.get('session')?.value;
  if (token && (await verifySession(token, process.env.SESSION_SECRET!))) {
    return NextResponse.next();
  }
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Не авторизован' }, { status: 401 });
  }
  return NextResponse.redirect(new URL('/login', request.url));
}

// Всё, кроме статики, формы входа и роута входа.
//
// Манифест, иконки и service worker браузер запрашивает без кук — у
// <link rel="manifest"> нет crossorigin="use-credentials", и Next его не
// добавляет. Без исключений они получали бы редирект на /login, iOS не
// разобрала бы манифест, и приложение осталось бы закладкой Safari. Молча:
// ни ошибки, ни записи в логах. Наружу при этом открыты только название,
// цвета и картинка — в базу эти маршруты не ходят.
//
// Новые исключения закрыты `$`: без него `icon` открыл бы и /iconxyz,
// и /icons/secret. Проверяется в middleware.test.ts.
export const config = {
  matcher: [
    '/((?!login|api/login|_next/static|_next/image|favicon.ico|manifest\\.webmanifest$|sw\\.js$|icon$|apple-icon$).*)',
  ],
};
