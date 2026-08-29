import 'server-only';
import type Anthropic from '@anthropic-ai/sdk';

export type Verdict =
  /** Ключ работает. */
  | { kind: 'ok' }
  /** Ключа не существует. Единственный исход, растящий счётчик попыток. */
  | { kind: 'rejected'; status: number; message: string }
  /** Ключ настоящий, но не годится либо проверить не удалось. Счётчик не трогаем. */
  | { kind: 'refused'; status: number; message: string };

/**
 * Проверяет ключ настоящим минимальным запросом к той же модели, что и разбор
 * фраз. Служебный бесплатный вызов (models.list, count_tokens) подтвердил бы
 * только существование ключа: ключ с нулевым балансом прошёл бы проверку,
 * и человек увидел бы «ключ принят», а потом отказ на первой же фразе.
 *
 * Ответ не читаем — важно только, что он не ошибка.
 */
export async function verifyApiKey(client: Anthropic): Promise<Verdict> {
  try {
    await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 1,
      // Размышления выключены намеренно: проверке нужен самый дешёвый и
      // предсказуемый запрос, а ответ мы всё равно не читаем. При умолчании
      // effort (high) выключение размышлений допустимо.
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'hi' }],
    });
    return { kind: 'ok' };
  } catch (error) {
    const status = (error as { status?: number }).status;

    // Ни один из ответов ниже не 401: экран настроек трактует 401 как
    // «сессия протухла» и уводит на /login — опечатка в ключе выбрасывала бы
    // человека из аккаунта.
    if (status === 401) {
      return { kind: 'rejected', status: 400, message: 'Anthropic не принял этот ключ' };
    }
    if (status === 403) {
      return {
        kind: 'refused',
        status: 400,
        message: 'Ключ настоящий, но у него нет доступа к модели либо на счету нет средств',
      };
    }
    if (status === 429) {
      return {
        kind: 'refused',
        status: 429,
        message: 'Anthropic сейчас ограничивает этот ключ, попробуй через несколько минут',
      };
    }
    return {
      kind: 'refused',
      status: 502,
      message: 'Не удалось проверить ключ, попробуй ещё раз',
    };
  }
}
