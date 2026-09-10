import { describe, it, expect } from 'vitest';
import {
  addDays, eachDay, isValidIsoDate, isWeekOutsideCalendarWindow, startOfMonth, startOfWeek,
  weekRange, weekdayOf,
} from './dates';

describe('addDays', () => {
  it('сдвигает внутри месяца', () => expect(addDays('2026-08-04', 3)).toBe('2026-08-07'));
  it('перескакивает через месяц', () => expect(addDays('2026-08-30', 3)).toBe('2026-09-02'));
  it('перескакивает через год назад', () => expect(addDays('2026-01-01', -1)).toBe('2025-12-31'));
  it('учитывает високосный год', () => expect(addDays('2028-02-28', 1)).toBe('2028-02-29'));
  it('не сдвигается на переводе часов', () => expect(addDays('2026-03-29', 1)).toBe('2026-03-30'));
});

describe('weekdayOf', () => {
  it('понедельник = 1', () => expect(weekdayOf('2026-08-03')).toBe(1));
  it('воскресенье = 7', () => expect(weekdayOf('2026-08-09')).toBe(7));
});

describe('startOfWeek', () => {
  it('от вторника даёт понедельник', () => expect(startOfWeek('2026-08-04')).toBe('2026-08-03'));
  it('от воскресенья даёт понедельник той же недели', () =>
    expect(startOfWeek('2026-08-09')).toBe('2026-08-03'));
  it('от понедельника даёт его же', () => expect(startOfWeek('2026-08-03')).toBe('2026-08-03'));
});

describe('weekRange', () => {
  it('отдаёт понедельник и воскресенье', () =>
    expect(weekRange('2026-08-04')).toEqual({ from: '2026-08-03', to: '2026-08-09' }));
  it('работает на стыке месяцев', () =>
    expect(weekRange('2026-09-01')).toEqual({ from: '2026-08-31', to: '2026-09-06' }));
});

describe('eachDay', () => {
  it('включает обе границы', () =>
    expect(eachDay('2026-08-03', '2026-08-05')).toEqual(['2026-08-03', '2026-08-04', '2026-08-05']));
  it('на одном дне даёт один элемент', () =>
    expect(eachDay('2026-08-03', '2026-08-03')).toEqual(['2026-08-03']));
  it('при перевёрнутом диапазоне даёт пусто', () =>
    expect(eachDay('2026-08-05', '2026-08-03')).toEqual([]));
});

describe('isValidIsoDate', () => {
  it('принимает нормальную дату', () => expect(isValidIsoDate('2026-08-04')).toBe(true));
  it('отвергает 31 февраля', () => expect(isValidIsoDate('2026-02-31')).toBe(false));
  it('отвергает мусор', () => {
    expect(isValidIsoDate('04.08.2026')).toBe(false);
    expect(isValidIsoDate('2026-8-4')).toBe(false);
    expect(isValidIsoDate('')).toBe(false);
  });
});

describe('isWeekOutsideCalendarWindow', () => {
  const window = { start: '2026-08-08', end: '2026-12-08' };

  it('нет окна — календарь не подключён вовсе, предупреждать не о чем', () => {
    expect(isWeekOutsideCalendarWindow('2030-01-06', '2030-01-12', null)).toBe(false);
  });

  it('неделя целиком внутри окна', () => {
    expect(isWeekOutsideCalendarWindow('2026-09-07', '2026-09-13', window)).toBe(false);
  });

  it('неделя целиком за концом окна — дальше копии нет', () => {
    expect(isWeekOutsideCalendarWindow('2027-01-04', '2027-01-10', window)).toBe(true);
  });

  it('неделя целиком раньше начала окна', () => {
    expect(isWeekOutsideCalendarWindow('2026-07-06', '2026-07-12', window)).toBe(true);
  });

  it('неделя лишь частично выходит за окно — считается внутри', () => {
    // Последний день недели совпадает с последним днём окна: копия за эту
    // неделю ещё есть, показывать пометку рано.
    expect(isWeekOutsideCalendarWindow('2026-12-07', '2026-12-13', window)).toBe(false);
  });
});

describe('startOfMonth', () => {
  it('возвращает первое число того же месяца', () => {
    expect(startOfMonth('2026-09-17')).toBe('2026-09-01');
  });

  it('на первом числе не двигается', () => {
    expect(startOfMonth('2026-09-01')).toBe('2026-09-01');
  });

  it('на последнем дне месяца остаётся в этом же месяце', () => {
    // Граница, на которой ошибается наивная арифметика через вычитание дней.
    expect(startOfMonth('2026-01-31')).toBe('2026-01-01');
  });

  it('в декабре не перепрыгивает в следующий год', () => {
    expect(startOfMonth('2026-12-31')).toBe('2026-12-01');
  });

  it('в феврале високосного года', () => {
    expect(startOfMonth('2028-02-29')).toBe('2028-02-01');
  });
});
