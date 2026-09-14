import 'server-only';
import { after } from 'next/server';
import { exportDeps, exportUser, type ExportDeps } from './export-run';
import { nowInZone } from './notify';

/**
 * Выгрузка сразу после правки задачи.
 *
 * Механизм по-прежнему один — сверщик. Толчок зовёт тот же exportUser, что и
 * планировщик, только не дожидаясь его пятиминутного прохода. Разница
 * считается заново целиком, так что толчку незачем знать, что именно
 * поменялось. Забытый обработчик ничего не ломает: его правку догонит
 * планировщик, просто не сразу.
 *
 * Одновременный проход планировщика безопасен: событие создаётся с id,
 * выведенным из ключа задачи, и повторная вставка сводится к правке.
 */
const EXPORT_NOW_BUDGET_MS = 10_000;

export async function exportNow(
  deps: ExportDeps,
  userId: string,
  clock: () => number = Date.now,
): Promise<{ applied: number; failed: number }> {
  // Дата — в поясе владельца, как у планировщика: иначе толчок и планировщик
  // строили бы разные окна, и на их краю задача то выгружалась, то снималась.
  const { today } = nowInZone(await deps.getTimezone(userId), new Date(clock()));
  return exportUser(deps, userId, today, clock() + EXPORT_NOW_BUDGET_MS, clock);
}

export function scheduleExport(userId: string): void {
  // after() — уже после ответа: интерфейс не ждёт Google, а платформа не
  // обрывает работу, пока та укладывается в лимит функции. Выполняется и при
  // неудачном запросе — тогда разница пуста и в Google никто не идёт.
  after(async () => {
    try {
      const result = await exportNow(exportDeps, userId);
      if (result.failed > 0) console.error('export-now: часть задач не выгружена в календарь');
    } catch {
      // Текст исключения в лог не идёт: в нём бывают названия задач и адреса.
      console.error('export-now: сбой выгрузки в календарь');
    }
  });
}
