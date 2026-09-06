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
      // Адрес, куда вести по нажатию. Кладём в data — это единственный
      // способ донести что-либо от обработчика push до notificationclick:
      // между ними нет общей памяти, уведомление и есть всё состояние.
      data: { url: payload.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      });
      // Приложение уже открыто — поднимаем его, а не плодим второе окно.
      // Но именно поднять мало: человек, у которого на экране висит
      // расписание, нажал на итоги недели и должен увидеть итоги недели.
      // Поэтому сначала navigate, потом focus.
      for (const client of windows) {
        if ('focus' in client) {
          if ('navigate' in client) {
            try {
              await client.navigate(url);
            } catch {
              // Клиент, которым не управляет этот service worker, отвергает
              // navigate. Но поднять окно всё равно лучше, чем тап сделает пусто.
            }
          }
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })(),
  );
});
