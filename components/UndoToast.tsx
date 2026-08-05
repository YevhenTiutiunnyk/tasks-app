'use client';

import { useEffect } from 'react';

interface Props {
  message: string;
  onUndo: () => void;
  onDismiss: () => void;
}

export function UndoToast({ message, onUndo, onDismiss }: Props) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 8000);
    return () => clearTimeout(timer);
  }, [onDismiss, message]);

  return (
    <div className="fixed inset-x-0 bottom-20 z-10 flex justify-center px-3">
      <div className="flex items-center gap-4 rounded-lg bg-neutral-800 px-4 py-2.5 text-sm text-white shadow-lg">
        <span>{message}</span>
        <button onClick={onUndo} className="font-semibold text-blue-300">Отменить</button>
      </div>
    </div>
  );
}
