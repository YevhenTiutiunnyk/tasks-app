// Service worker без обработчика fetch — сознательно.
//
// Он нужен не ради офлайна: на iOS Web Push доступен только веб-приложению
// с главного экрана и только при зарегистрированном service worker. Кеш здесь
// был бы вреден — расписание живёт в базе, и закешированный ответ показал бы
// протухшие задачи как настоящие.

self.addEventListener('install', () => {
  // Не ждать закрытия старых вкладок: обновлённый обработчик нужен сразу.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  // Без данных показывать нечего, но промолчать нельзя: iOS требует, чтобы
  // на каждый push появилось видимое уведомление, иначе со временем отзывает
  // разрешение у приложения.
  let payload = { title: 'Расписание', body: 'Скоро начнётся задача' };
  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      payload.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon',
      badge: '/icon',
      // Уведомление про ту же задачу заменяет предыдущее, а не копится
      // второй строкой в шторке.
      tag: payload.tag,
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      // Приложение уже открыто — поднимаем его, а не плодим второе окно.
      for (const client of windows) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('/');
    })(),
  );
});
