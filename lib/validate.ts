import { isValidIsoDate } from './dates';
import { parseOccurrenceId } from './recurrence';
import type { Category, Operation, ParseResult, Task } from './types';

export interface ValidationContext {
  tasks: Task[];
  categories: Category[];
}

export interface Rejected {
  operation: Operation;
  reason: string;
}

export interface ValidationResult {
  operations: Operation[];
  rejected: Rejected[];
  needsTime: ParseResult['needsTime'];
}

const MAX_DURATION = 24 * 60;

/** Возвращает причину отказа или null, если операция годная. Может править операцию на месте. */
function check(operation: Operation, context: ValidationContext): string | null {
  const knownIds = new Set(context.tasks.map((t) => t.id));
  const knownCategories = new Set(context.categories.map((c) => c.id));

  if (operation.type !== 'create') {
    // Ссылка на вхождение серии допустима: задачи в базе ещё нет, её материализуют при применении.
    const isOccurrence = operation.taskId.startsWith('occ:');
    if (!isOccurrence && !knownIds.has(operation.taskId)) {
      return 'не нашёл такую задачу в расписании';
    }
  }

  if (operation.type === 'delete') return null;

  if (operation.type === 'create' && operation.title.trim() === '') {
    return 'пустое название';
  }
  if (operation.type === 'update' && operation.title !== null && operation.title.trim() === '') {
    return 'пустое название';
  }

  if (operation.date !== null && !isValidIsoDate(operation.date)) {
    return 'непонятная дата';
  }
  if (operation.startMinute !== null && (operation.startMinute < 0 || operation.startMinute > 1439)) {
    return 'время за пределами суток';
  }
  if (
    operation.durationMinutes !== null &&
    (operation.durationMinutes <= 0 || operation.durationMinutes > MAX_DURATION)
  ) {
    return 'непонятная длительность';
  }

  if (operation.type === 'create' && operation.recurrence !== null) {
    const { weekdays, startsOn, endsOn } = operation.recurrence;
    if (weekdays.length === 0 || weekdays.some((d) => d < 1 || d > 7)) {
      return 'непонятные дни недели в повторе';
    }
    if (!isValidIsoDate(startsOn)) return 'непонятная дата начала повтора';
    if (endsOn !== null && !isValidIsoDate(endsOn)) return 'непонятная дата конца повтора';
  }

  // Выдуманная категория — не повод выбрасывать всю операцию, просто снимаем её.
  if (operation.categoryId !== null && !knownCategories.has(operation.categoryId)) {
    operation.categoryId = null;
  }

  return null;
}

export function validateParseResult(
  result: ParseResult,
  context: ValidationContext,
): ValidationResult {
  const operations: Operation[] = [];
  const rejected: Rejected[] = [];
  const indexMap = new Map<number, number>();   // старый индекс → новый

  result.operations.forEach((operation, oldIndex) => {
    const copy = structuredClone(operation);
    const reason = check(copy, context);
    if (reason) {
      rejected.push({ operation: copy, reason });
      return;
    }
    indexMap.set(oldIndex, operations.length);
    operations.push(copy);
  });

  const needsTime = result.needsTime
    .filter((entry) => indexMap.has(entry.operationIndex))
    .map((entry) => ({
      operationIndex: indexMap.get(entry.operationIndex)!,
      question: entry.question,
    }));

  return { operations, rejected, needsTime };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Идентификатор задачи — либо uuid строки в базе, либо синтетический
 * occ:<правило>:<дата> у ещё не материализованного вхождения серии.
 * Без этой проверки чужая строка доходит до Postgres и роняет запрос
 * приведением к uuid, то есть отвечает 500 вместо внятного 400.
 */
export function isValidTaskId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (UUID.test(value)) return true;
  const occurrence = parseOccurrenceId(value);
  return occurrence !== null && UUID.test(occurrence.recurrenceId) && isValidIsoDate(occurrence.date);
}

/**
 * Те же границы времени и длительности, что проверяются у ответа модели.
 * Ручной ввод из интерфейса не должен быть доверенней, чем вывод Claude.
 */
export function isValidSlot(fields: {
  startMinute?: number | null;
  durationMinutes?: number | null;
}): boolean {
  const { startMinute, durationMinutes } = fields;
  if (startMinute != null && (!Number.isInteger(startMinute) || startMinute < 0 || startMinute > 1439)) {
    return false;
  }
  if (
    durationMinutes != null &&
    (!Number.isInteger(durationMinutes) || durationMinutes <= 0 || durationMinutes > MAX_DURATION)
  ) {
    return false;
  }
  return true;
}
