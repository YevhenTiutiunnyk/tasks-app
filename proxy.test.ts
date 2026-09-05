import { describe, expect, it } from 'vitest';
import { config } from './proxy';

// Матчер — единственное, что решает, дойдёт ли запрос до проверки сессии.
// Ошибка здесь не падает и не логируется: манифест просто получает редирект
// на /login, iOS молча его не разбирает, и приложение остаётся закладкой.
// Поэтому регулярка проверяется отдельно от самого proxy.
//
// Проверять голую строку матчера нельзя: Next компилирует её не как есть,
// а обкладывает с двух сторон. Наивное `^${matcher}$` слепо ровно там, где
// ломаются «очевидные» починки якорей: `login$` внутри lookahead выглядит
// безобидно и при этом перестаёт исключать /login.rsc, потому что настоящий
// `$` стоит за транспортным суффиксом, а не перед ним.
//
// Обёртки взяты из скомпилированной формы (.next/server/functions-config-
// manifest.json, поле regexp; originalSource там совпадает с config.matcher[0]):
// необязательный префикс запроса данных RSC и группа транспортных суффиксов
// с хвостом. Собираются из config.matcher[0], а не переписаны целиком, иначе
// тест следил бы за копией матчера, а не за матчером.
const NEXT_DATA_PREFIX = String.raw`(?:\/(_next\/data\/[^/]{1,}))?`;
const NEXT_TRANSPORT_SUFFIX = String.raw`(\.json|\.rsc|\.segments\/.+\.segment\.rsc)?[\/#\?]?$`;
const matcher = new RegExp(
  // Слеши Next экранирует; на смысл это не влияет, но держит нашу сборку
  // символ в символ равной той, что уходит в сборку.
  `^${NEXT_DATA_PREFIX}(?:${config.matcher[0].replaceAll('/', String.raw`\/`)})${NEXT_TRANSPORT_SUFFIX}`,
);

/** true — запрос перехватывает proxy, то есть путь под сессией. */
function guarded(pathname: string): boolean {
  return matcher.test(pathname);
}

describe('матчер proxy', () => {
  it('пропускает без сессии то, что браузер запрашивает анонимно', () => {
    // Манифест браузер тянет без кук: у <link rel="manifest"> нет
    // crossorigin="use-credentials", и Next его не добавляет.
    expect(guarded('/manifest.webmanifest')).toBe(false);
    expect(guarded('/sw.js')).toBe(false);
    expect(guarded('/icon')).toBe(false);
    expect(guarded('/apple-icon')).toBe(false);
    expect(guarded('/favicon.ico')).toBe(false);
  });

  it('по-прежнему закрывает расписание, настройки и api', () => {
    // Все роуты приложения, кроме api/notify: своей проверки сессии ни один
    // из них не делает, и пропуск любого означал бы дыру наружу. /checklist
    // и /api/checklist — тот же список, продолженный сюда: матчер их и так
    // покрывает, но без строк здесь эта регрессионная сеть их не ловит.
    expect(guarded('/')).toBe(true);
    expect(guarded('/settings')).toBe(true);
    expect(guarded('/checklist')).toBe(true);
    expect(guarded('/api/week')).toBe(true);
    expect(guarded('/api/command')).toBe(true);
    expect(guarded('/api/undo')).toBe(true);
    expect(guarded('/api/task')).toBe(true);
    expect(guarded('/api/clarify')).toBe(true);
    expect(guarded('/api/settings')).toBe(true);
    expect(guarded('/api/push')).toBe(true);
    expect(guarded('/api/checklist')).toBe(true);
  });

  it('закрывает те же пути в транспортных формах RSC', () => {
    // Клиентская навигация просит те же страницы под другими именами:
    // .rsc, .json и запросом данных с идентификатором сборки в пути.
    // Матчер, слепой к этим формам, отдал бы содержимое страницы мимо
    // проверки сессии.
    expect(guarded('/settings.rsc')).toBe(true);
    expect(guarded('/api/week.rsc')).toBe(true);
    expect(guarded('/api/week.json')).toBe(true);
    expect(guarded('/_next/data/BUILD/settings.json')).toBe(true);
  });

  it('оставляет открытым вход и в транспортных формах', () => {
    // Обратная сторона того же: страницу входа Next префетчит как /login.rsc.
    // Закрой матчер её — прокси отправил бы префетч в редирект и сломал бы
    // клиентскую навигацию на вход.
    expect(guarded('/login.rsc')).toBe(false);
    expect(guarded('/login.segments/_tree.segment.rsc')).toBe(false);
  });

  it('не открывает наружу пути, лишь начинающиеся как исключения', () => {
    // Наивное `icon` в lookahead открыло бы и это.
    expect(guarded('/iconxyz')).toBe(true);
    expect(guarded('/icons/secret')).toBe(true);
    expect(guarded('/apple-icons')).toBe(true);
    expect(guarded('/sw.js.map')).toBe(true);
    expect(guarded('/manifest.webmanifest.bak')).toBe(true);
    // Якорь `(?:$|\.)` там, где `$` применить нельзя: он должен пускать
    // транспортные формы и при этом не пускать чужие пути.
    expect(guarded('/loginxyz')).toBe(true);
    expect(guarded('/login/')).toBe(true);
    expect(guarded('/login/x')).toBe(true);
    // Точка в favicon.ico — настоящая точка, а не «любой символ».
    expect(guarded('/faviconXico')).toBe(true);
    expect(guarded('/favicon.icoX')).toBe(true);
  });

  it('пропускает эндпоинт отправки уведомлений', () => {
    // Его дёргает планировщик из Supabase — сессии у него нет.
    expect(guarded('/api/notify')).toBe(false);
    expect(guarded('/api/notifyxyz')).toBe(true);
    expect(guarded('/api/notify/all')).toBe(true);
  });

  it('оставляет открытым вход', () => {
    expect(guarded('/login')).toBe(false);
  });

  it('пропускает роуты Better Auth', () => {
    // Better Auth — catch-all: начало входа, колбэк от Google, выход.
    // Без этого исключения Google возвращал бы пользователя на колбэк, прокси
    // видел бы отсутствие сессии и слал бы его на /login — по кругу и молча.
    expect(guarded('/api/auth/sign-in/social')).toBe(false);
    expect(guarded('/api/auth/callback/google')).toBe(false);
    expect(guarded('/api/auth/sign-out')).toBe(false);
  });

  it('не открывает наружу пути, лишь начинающиеся как api/auth', () => {
    // Роль якоря здесь играет слеш: `$` тут применить нельзя, путей много.
    expect(guarded('/api/authxyz')).toBe(true);
    expect(guarded('/api/auth')).toBe(true);
  });

  it('закрывает исчезнувший роут пароля', () => {
    expect(guarded('/api/login')).toBe(true);
  });
});
