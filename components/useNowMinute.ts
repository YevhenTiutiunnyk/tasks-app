'use client';

import { useEffect, useState } from 'react';

/**
 * Текущее время в минутах от полуночи, по часам устройства.
 *
 * null до монтирования: на сервере текущего времени пользователя знать
 * неоткуда, а отрисовать что-то и тут же поменять — это несовпадение
 * разметки при гидратации.
 */
export function useNowMinute(): number | null {
  const [minute, setMinute] = useState<number | null>(null);

  useEffect(() => {
    const read = () => {
      const now = new Date();
      setMinute(now.getHours() * 60 + now.getMinutes());
    };
    read();
    const timer = setInterval(read, 60_000);
    return () => clearInterval(timer);
  }, []);

  return minute;
}
