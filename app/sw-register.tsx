'use client';

import { useEffect } from 'react';

/**
 * Регистрирует service worker. Разметки не даёт.
 *
 * Монтируется в layout, то есть работает и на странице входа — это безвредно:
 * обработчик пустой, а зарегистрировать его заранее полезно.
 */
export default function ServiceWorkerRegistrar() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;

    void navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      // Расписание не зависит от service worker ничем: без него не будет
      // только будущих уведомлений. Поэтому ошибка не должна ломать экран.
      console.warn('Не удалось зарегистрировать service worker', error);
    });
  }, []);

  return null;
}
