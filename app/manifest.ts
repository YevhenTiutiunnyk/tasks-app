import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Расписание',
    short_name: 'Расписание',
    description: 'Личное расписание на неделю',
    start_url: '/',
    // Без standalone iOS запускает сайт в Safari с адресной строкой, то есть
    // как закладку. Кнопка «назад» при этом пропадает, но в приложении есть
    // свои переходы в обе стороны между расписанием и настройками.
    display: 'standalone',
    background_color: '#ffffff',
    // Формат манифеста не знает про светлую и тёмную схему — вариантов под
    // prefers-color-scheme нет. Их закрывает themeColor в app/layout.tsx.
    theme_color: '#ffffff',
    icons: [{ src: '/icon', sizes: '512x512', type: 'image/png' }],
  };
}
