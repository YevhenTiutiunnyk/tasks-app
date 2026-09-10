-- Выгрузка задач в отдельный календарь Google.
--
-- ПОЧЕМУ СВЕРЩИК, А НЕ ОЧЕРЕДЬ
--
-- Задача меняется в восьми местах: шесть в lib/apply.ts плюс правка
-- в /api/clarify и переключение «сделано» в /api/task. Очередь пришлось
-- бы завести в каждом из восьми, и забытое место молча не выгружалось бы.
-- Сверщик смотрит на всё окно целиком и не знает, что именно поменялось;
-- забыть его нельзя.
--
-- ПОЧЕМУ ОТПЕЧАТОК, А НЕ КОПИЯ ПОЛЕЙ
--
-- Иначе таблица связок стала бы второй копией расписания, которую надо
-- держать в соответствии с первой. Отпечатка достаточно, чтобы понять
-- «разошлось или нет», а больше от него ничего не требуется.
--
-- ПОЧЕМУ ДВЕ ДАТЫ ВМЕСТО ОДНОЙ
--
-- synced_at — быстрый проход раз в пять минут, сравнение с нашей же
-- таблицей. reconciled_at — полная сверка раз в сутки, с чтением
-- календаря. Это разные вещи: первая не видит правок, сделанных руками
-- в Google, вторая только за ними и ходит.

begin;

create table google_export (
  user_id       text        not null primary key references "user" ("id") on delete cascade,
  calendar_id   text,
  enabled       boolean     not null default false,
  synced_at     timestamptz,
  reconciled_at timestamptz,
  broken_at     timestamptz,
  created_at    timestamptz not null default now()
);

-- Связка живёт ровно столько, сколько включена выгрузка: выключил —
-- каскад убирает всё, и повторное включение начинается с чистого листа.
create table google_task_events (
  user_id     text        not null references google_export (user_id) on delete cascade,
  task_key    text        not null,
  event_id    text        not null,
  fingerprint text        not null,
  updated_at  timestamptz not null default now(),
  primary key (user_id, task_key)
);

commit;
