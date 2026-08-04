import { describe, it, expect } from 'vitest';
import { getSettings, saveSettings, sql } from './db';

const run = process.env.DATABASE_URL ? describe : describe.skip;

run('settings', () => {
  it('читает строку настроек с категориями по умолчанию', async () => {
    const settings = await getSettings();
    expect(settings.workStartMinute).toBe(540);
    expect(settings.workEndMinute).toBe(1080);
    expect(settings.categories.map((c) => c.id)).toContain('work');
    await sql.end();
  });

  it('сохраняет и читает обратно', async () => {
    const before = await getSettings();
    await saveSettings({ ...before, aboutMe: 'встаю в 7' });
    expect((await getSettings()).aboutMe).toBe('встаю в 7');
    await saveSettings(before);
    await sql.end();
  });
});
