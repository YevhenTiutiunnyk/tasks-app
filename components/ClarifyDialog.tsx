'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

export interface ClarifyItem {
  taskId: string;
  title: string;
  question: string;
}

interface Props {
  items: ClarifyItem[];
  today: string;
  /**
   * Отдаёт обновлённую неделю и строки, с которыми ещё предстоит разобраться.
   * Пустой список размонтирует окно; непустой оставляет его открытым — так
   * сообщение о неразобранных фразах доживает до глаз пользователя.
   */
  onDone: (week: unknown, remaining: ClarifyItem[]) => void;
  onLater: () => void;
}

export function ClarifyDialog({ items, today, onDone, onLater }: Props) {
  const router = useRouter();
  const [values, setValues] = useState<Record<string, string>>({});
  const [allDay, setAllDay] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError('');
    // Задачи с включённым тумблером остаются на весь день — их не отправляем.
    const answers = items
      .filter((item) => !allDay[item.taskId] && (values[item.taskId] ?? '').trim())
      .map((item) => ({ taskId: item.taskId, text: values[item.taskId] }));

    // Пустая отправка бывает двух разных смыслов. Если по каждой задаче стоит
    // тумблер «весь день» — человек выбрал осознанно, окно можно закрывать
    // молча: задачи и так на весь день. А если что-то просто не заполнено,
    // тихое закрытие выглядит как сработавшее «Готово», хотя не отправлено
    // ничего и задачи молча остались на весь день.
    if (answers.length === 0) {
      setBusy(false);
      if (items.some((item) => !allDay[item.taskId])) {
        setError('Ничего не заполнено: впиши время или отметь «весь день». «Позже» закроет окно — задачи останутся на весь день.');
        return;
      }
      onLater();
      return;
    }

    try {
      const response = await fetch('/api/clarify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ answers, today }),
      });
      if (response.status === 401) {
        router.push('/login');
        return;
      }
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? 'Не получилось');
        return;
      }
      // В окне остаётся то, с чем ещё не разобрались: строки, которые сервер
      // не сумел разобрать, и строки, которые пользователь не заполнил и не
      // отметил тумблером. Второе важно не меньше первого: иначе задача молча
      // осталась бы на весь день, хотя человек такого не выбирал. Задачи с
      // включённым тумблером на сервер не уходят и в остаток не попадают.
      const failed: string[] = body.failed ?? [];
      const remaining = items.filter(
        (item) =>
          failed.includes(item.taskId) ||
          (!allDay[item.taskId] && !(values[item.taskId] ?? '').trim()),
      );
      // Неделю показываем сразу — часть задач уже встала на места, — но окно
      // не закрываем, пока остаток не пуст: иначе сообщение об ошибке умрёт
      // в том же кадре вместе с размонтированием.
      if (failed.length > 0) {
        setError('Часть фраз разобрать не вышло — попробуй сказать иначе');
      }
      onDone(body.week, remaining);
    } catch {
      setError('Нет связи с сервером');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-sm rounded-xl bg-surface p-5">
        <h2 className="text-base font-semibold">Уточни время</h2>
        <p className="mb-3 text-xs text-muted">
          {items.length === 1 ? 'Для одной задачи не понял, когда её ставить' : `Для ${items.length} задач не понял, когда их ставить`}
        </p>

        {items.map((item) => (
          <div key={item.taskId} className="border-t border-hairline py-3">
            <p className="text-sm font-medium">{item.title}</p>
            {/* Вопрос модели сформулирован под конкретный случай: когда не
                понятен даже день, он спрашивает и день, и время. Без него на
                экране остаётся только общий подзаголовок, и разница пропадает. */}
            {item.question && <p className="mb-2 text-xs text-muted">{item.question}</p>}
            <div className="flex items-center gap-2">
              <input
                value={values[item.taskId] ?? ''}
                onChange={(e) => setValues({ ...values, [item.taskId]: e.target.value })}
                disabled={allDay[item.taskId]}
                placeholder="🎤 например: завтра в 8 утра, час"
                className="flex-1 rounded-md border border-hairline bg-surface px-2.5 py-1.5 text-xs disabled:opacity-40"
              />
              <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted">
                <input
                  type="checkbox"
                  checked={allDay[item.taskId] ?? false}
                  onChange={(e) => setAllDay({ ...allDay, [item.taskId]: e.target.checked })}
                />
                весь день
              </label>
            </div>
          </div>
        ))}

        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}

        <div className="mt-3 flex justify-end gap-2 border-t border-hairline pt-3">
          <button onClick={onLater} className="rounded-md border border-hairline px-3 py-1.5 text-xs">
            Позже
          </button>
          <button
            onClick={() => void submit()}
            disabled={busy}
            className="rounded-md bg-ink px-3 py-1.5 text-xs text-paper disabled:opacity-50"
          >
            {busy ? '…' : 'Готово'}
          </button>
        </div>
      </div>
    </div>
  );
}
