'use client';

import { useEffect, useRef } from 'react';

interface Props {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
}

export function UndoToast({ message, onUndo, onDismiss }: Props) {
  // onDismiss обычно приходит инлайновой стрелкой с новой идентичностью на
  // каждом рендере родителя. Держим актуальный колбэк в ref и не завязываем
  // на него таймер, иначе любой рендер родителя (смена wide, повторный
  // setWeek и т.п.) сбрасывал бы восьмисекундный отсчёт заново.
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);

  useEffect(() => {
    const timer = setTimeout(() => dismissRef.current(), 8000);
    return () => clearTimeout(timer);
  }, [message]);

  return (
    <div className="fixed inset-x-0 bottom-20 z-10 flex justify-center px-3">
      <div className="flex items-center gap-4 rounded-lg bg-ink px-4 py-2.5 text-sm text-paper shadow-lg">
        <span>{message}</span>
        <button onClick={onUndo} className="font-semibold text-blue-300">Отменить</button>
      </div>
    </div>
  );
}
