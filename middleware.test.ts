import { describe, expect, it } from 'vitest';
import { config } from './middleware';

// Матчер — единственное, что решает, дойдёт ли запрос до проверки сессии.
// Ошибка здесь не падает и не логируется: манифест просто получает редирект
// на /login, iOS молча его не разбирает, и приложение остаётся закладкой.
// Поэтому регулярка проверяется отдельно от самого middleware.
const matcher = new RegExp(`^${config.matcher[0]}$`);

/** true — запрос перехватывает middleware, то есть путь под паролем. */
function guarded(pathname: string): boolean {
  return matcher.test(pathname);
}

describe('матчер middleware', () => {
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

  it('оставляет открытым вход', () => {
    expect(guarded('/login')).toBe(false);
    expect(guarded('/api/login')).toBe(false);
  });
});
