export interface Task {
  id: string;
  title: string;
  date: string;                    // 'YYYY-MM-DD'
  startMinute: number | null;      // минуты от полуночи; null у задач на весь день
  durationMinutes: number | null;
  allDay: boolean;
  categoryId: string | null;
  done: boolean;
  recurrenceId: string | null;
  recurrenceDate: string | null;   // исходная дата вхождения серии
}

export interface Recurrence {
  id: string;
  title: string;
  weekdays: number[];              // 1 = понедельник … 7 = воскресенье
  startMinute: number | null;
  durationMinutes: number | null;
  allDay: boolean;
  categoryId: string | null;
  startsOn: string;
  endsOn: string | null;
}

export interface RecurrenceException {
  recurrenceId: string;
  date: string;
}

export interface Category {
  id: string;
  name: string;
  color: string;                   // hex, например '#3b82f6'
}

export interface Settings {
  workStartMinute: number;
  workEndMinute: number;
  aboutMe: string;
  categories: Category[];
}

export type Operation =
  | {
      type: 'create';
      title: string;
      date: string | null;
      startMinute: number | null;
      durationMinutes: number | null;
      allDay: boolean | null;
      categoryId: string | null;
      recurrence: { weekdays: number[]; startsOn: string; endsOn: string | null } | null;
    }
  | {
      type: 'update';
      taskId: string;
      title: string | null;
      date: string | null;
      startMinute: number | null;
      durationMinutes: number | null;
      allDay: boolean | null;
      categoryId: string | null;
      /**
       * Полная замена вместо частичной правки. Для модели null означает
       * «поле не названо, не трогать», и это верно: фраза упоминает одно-два
       * поля. Карточка задачи присылает все поля разом, и там ровно тот же
       * null означает «очистить». Флаг разделяет эти два смысла; путь модели
       * его не выставляет никогда.
       */
      replace?: boolean;
    }
  | { type: 'delete'; taskId: string };

export interface ParseResult {
  operations: Operation[];
  needsTime: { operationIndex: number; question: string }[];
  reply: string;
}
