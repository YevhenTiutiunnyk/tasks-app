import type { Settings } from './types';

/**
 * Единственный источник умолчаний.
 *
 * В user_settings нет ни одного default — иначе появился бы второй источник
 * правды, способный разойтись с этим незаметно. У нового человека строки нет,
 * getSettings возвращает это, а первое сохранение настроек создаёт строку.
 */
export const DEFAULT_SETTINGS: Settings = {
  workStartMinute: 540,
  workEndMinute: 1080,
  aboutMe: '',
  categories: [
    { id: 'work', name: 'Работа', color: '#3b82f6' },
    { id: 'personal', name: 'Личное', color: '#a855f7' },
    { id: 'sport', name: 'Спорт', color: '#22c55e' },
    { id: 'health', name: 'Здоровье', color: '#ef4444' },
    { id: 'home', name: 'Дом', color: '#f59e0b' },
  ],
  notifyBeforeMinutes: 15,
};

/** Пояс живёт отдельно от Settings — см. комментарий у getTimezone в lib/db.ts. */
export const DEFAULT_TIMEZONE = 'Europe/Amsterdam';
