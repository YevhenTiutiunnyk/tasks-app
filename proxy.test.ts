import { describe, expect, it } from 'vitest';
import { config } from './proxy';

// Матчер — единственное, что решает, дойдёт ли запрос до проверки сессии.
// Ошибка здесь не падает и не логируется: манифест просто получает редирект
// на /login, iOS молча его не разбирает, и приложение остаётся закладкой.
// Поэтому регулярка проверяется отдельно от самого proxy.
const matcher = new RegExp(`^${config.matcher[0]}$`);

/** true — запрос перехватывает proxy, то есть путь под паролем. */
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
  });

  it('по-прежнему закрывает расписание, настройки и api', () => {
    expect(guarded('/')).toBe(true);
    expect(guarded('/settings')).toBe(true);
    expect(guarded('/api/week')).toBe(true);
    expect(guarded('/api/command')).toBe(true);
    expect(guarded('/api/undo')).toBe(true);
  });

  it('не открывает наружу пути, лишь начинающиеся как исключения', () => {
    // Наивное `icon` в lookahead открыло бы и это.
    expect(guarded('/iconxyz')).toBe(true);
    expect(guarded('/icons/secret')).toBe(true);
    expect(guarded('/apple-icons')).toBe(true);
    expect(guarded('/sw.js.map')).toBe(true);
    expect(guarded('/manifest.webmanifest.bak')).toBe(true);
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
