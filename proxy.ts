import { NextResponse, type NextRequest } from 'next/server';
import { auth } from '@/lib/auth';

// Начиная с Next 16 это соглашение зовётся `proxy`: файл называется proxy.ts,
// функция — proxy. Прежнее имя, middleware, ещё работает, но собирается
// с предупреждением о том, что соглашение устарело.
//
// Здесь стоит НАСТОЯЩАЯ проверка сессии, с обращением к базе, а не проверка
// наличия куки. Так решено сознательно: getSessionCookie у Better Auth куку
// не проверяет, и опора на него означала бы, что войти может любой, кто сам
// себе эту куку выставит. Замок в приложении остаётся ровно один — этот файл;
// роуты своей проверки не делают.
//
// Это законно потому, что в Next 16 proxy по умолчанию работает на
// Node-рантайме (опция runtime здесь запрещена и бросает ошибку).
export async function proxy(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (session) {
    return NextResponse.next();
  }
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Не авторизован' }, { status: 401 });
  }
  return NextResponse.redirect(new URL('/login', request.url));
}

// Всё, кроме статики, страницы входа и роутов Better Auth.
//
// Манифест, иконки и service worker браузер запрашивает без кук — у
// <link rel="manifest"> нет crossorigin="use-credentials", и Next его не
// добавляет. Без исключений они получали бы редирект на /login, iOS не
// разобрала бы манифест, и приложение осталось бы закладкой Safari. Молча:
// ни ошибки, ни записи в логах. Наружу при этом открыты только название,
// цвета и картинка — в базу эти маршруты не ходят.
//
// Сюда же добавлен api/notify: его дёргает планировщик из Supabase, у которого
// никакой сессии нет и быть не может. Роут защищён своим секретом в заголовке.
//
// Однократные исключения закрыты `$`: без него `icon` открыл бы и /iconxyz,
// и /icons/secret. У api/auth/ якорь другой — слеш: Better Auth это catch-all
// с десятком путей, и `$` тут всё сломал бы. Слеш не пускает /api/authxyz.
// Проверяется в proxy.test.ts.
export const config = {
  matcher: [
    '/((?!login|api/auth/|api/notify$|_next/static|_next/image|favicon.ico|manifest\\.webmanifest$|sw\\.js$|icon$|apple-icon$).*)',
  ],
};
