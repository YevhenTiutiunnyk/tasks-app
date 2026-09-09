-- Копия выбранных календарей Google. Только чтение: ступень A прав записи
-- не просит.
--
-- ПОЧЕМУ ОТДЕЛЬНЫЕ ТАБЛИЦЫ, А НЕ tasks
--
-- Задачу правят, удаляют, отмечают сделанной, у неё категория, горизонт
-- и откат. Встреча ничего этого не умеет. В одной таблице каждый путь
-- записи пришлось бы учить проверке «а это не чужое?» — и однажды
-- забыть. Отдельная таблица делает защиту структурной.
--
-- ПОЧЕМУ ВРЕМЯ ТОЛЬКО АБСОЛЮТНОЕ
--
-- В проекте время задач — локальные минуты без пояса, и это верно для
-- задач. Встреча приходит из Google абсолютным моментом. Хранить рядом
-- выведенные дату и минуты значило бы держать кэш, который врёт после
-- смены часового пояса, и который всё равно не описывает встречу,
-- пересекающую полночь. Локальное представление выводится на чтении.
--
-- ПОЧЕМУ cascade, А НЕ restrict КАК У СНИМКОВ НЕДЕЛИ
--
-- Это кэш чужих данных, восстановимый одной пересинхронизацией.

begin;

create table google_calendars (
  user_id      text        not null references "user" ("id") on delete cascade,
  calendar_id  text        not null,
  summary      text        not null,
  selected     boolean     not null default false,
  sync_token   text,
  window_start date,
  window_end   date,
  synced_at    timestamptz,
  broken_at    timestamptz,
  created_at   timestamptz not null default now(),
  primary key (user_id, calendar_id)
);

create table google_events (
  user_id           text        not null,
  calendar_id       text        not null,
  event_id          text        not null,
  title             text        not null,
  starts_at         timestamptz not null,
  ends_at           timestamptz not null,
  all_day           boolean     not null default false,
  mine              boolean     not null,
  organizer_email   text,
  google_updated_at timestamptz not null,
  primary key (user_id, calendar_id, event_id),
  foreign key (user_id, calendar_id)
    references google_calendars (user_id, calendar_id) on delete cascade
);

-- Выборка недели идёт по пересечению отрезка с окном недели, а не по дате
-- начала: многодневная встреча обязана попасть в неделю, начавшись до неё.
create index google_events_span_idx on google_events (user_id, starts_at, ends_at);

commit;
