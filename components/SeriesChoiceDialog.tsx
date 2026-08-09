'use client';

interface Props {
  action: 'изменить' | 'удалить';
  /** Предупреждение о том, что часть правки к серии неприменима. */
  note?: string;
  onChoose: (scope: 'one' | 'series') => void;
  onCancel: () => void;
}

export function SeriesChoiceDialog({ action, note, onChoose, onCancel }: Props) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-xs rounded-xl bg-surface p-5">
        <h2 className="mb-1 text-base font-semibold">Это повторяющаяся задача</h2>
        <p className="mb-2 text-xs text-muted">Что именно {action}?</p>
        {note && <p className="mb-4 text-xs text-amber-600">{note}</p>}
        <div className="space-y-2">
          <button
            onClick={() => onChoose('one')}
            className="w-full rounded-md bg-ink px-3 py-2 text-sm text-paper"
          >
            Только это занятие
          </button>
          <button
            onClick={() => onChoose('series')}
            className="w-full rounded-md border border-hairline px-3 py-2 text-sm"
          >
            Всю серию
          </button>
          <button onClick={onCancel} className="w-full px-3 py-1.5 text-xs text-muted">
            Отмена
          </button>
        </div>
      </div>
    </div>
  );
}
