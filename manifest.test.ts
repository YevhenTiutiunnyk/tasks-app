import { describe, expect, it } from 'vitest';
import manifest from './app/manifest';

describe('манифест', () => {
  it('описывает приложение так, чтобы iOS запускала его своим окном', () => {
    const result = manifest();
    expect(result.name).toBe('Расписание');
    expect(result.short_name).toBe('Расписание');
    expect(result.start_url).toBe('/');
    // Без standalone iOS оставит адресную строку Safari, то есть закладку.
    expect(result.display).toBe('standalone');
  });

  it('даёт ровно одну иконку 512×512', () => {
    // iOS берёт иконку главного экрана из apple-touch-icon и записи манифеста
    // игнорирует. Вторая запись здесь потребовала бы generateImageMetadata
    // и путей /icon/<id>, то есть лишней неопределённости в матчере.
    const icons = manifest().icons ?? [];
    expect(icons).toHaveLength(1);
    expect(icons[0]).toMatchObject({
      src: '/icon',
      sizes: '512x512',
      type: 'image/png',
    });
  });
});
