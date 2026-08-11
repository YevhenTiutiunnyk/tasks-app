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
  let result;
  try {
    // returnHeaders: true — не украшение вызова, а единственный способ забрать
    // у Better Auth то, что он приготовил для браузера. Форму подсказывают
    // типы getSession (node_modules/better-auth/dist/types/api.d.mts): при
    // returnHeaders ответ приходит как { headers, response }, где response —
    // сама сессия или null.
    result = await auth.api.getSession({ headers: request.headers, returnHeaders: true });
  } catch (error) {
    // Лог без куки и заголовков: в них лежит содержимое сессии, а причина
    // отказа — обрыв связи с базой — в них не написана и без утечки видна.
    console.error('proxy: не удалось проверить сессию', error);
    // Не редирект на /login: моргнувшая база выбросила бы на вход и уже
    // вошедшего пользователя, а сам вход без базы тоже не сработает — это
    // была бы дорога в никуда. 503 честно говорит, что дело не в сессии, и
    // одинаков для страниц и для api — здесь, в отличие от развилки ниже,
    // разбирать ответ на стороне клиента не нужно: это не отказ входа,
    // а сообщение "попробуй позже" в любом виде.
    return NextResponse.json({ error: 'Сервис временно недоступен' }, { status: 503 });
  }
  if (result.response) {
    const response = NextResponse.next();
    // Скольжение срока живёт здесь. По истечении updateAge getSession сам
    // продлевает строку сессии в базе и кладёт свежую куку в заголовки своего
    // контекста, но NextResponse.next() их не наследует — без переноса срок
    // в браузере навсегда остался бы тем, что выдан при входе, и сессия
    // умирала бы через 30 дней после входа, а не после последнего визита.
    // Заметить это можно было бы только через месяц и только по внезапному
    // возврату на страницу входа.
    //
    // append и весь список: кук бывает несколько (токен сессии и её кэш),
    // а set оставил бы одну.
    for (const cookie of result.headers.getSetCookie()) {
      response.headers.append('set-cookie', cookie);
    }
    return response;
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
