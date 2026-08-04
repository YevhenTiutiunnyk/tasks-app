create extension if not exists "pgcrypto";

create table recurrences (
  id               uuid primary key default gen_random_uuid(),
  title            text        not null,
  weekdays         smallint[]  not null,
  start_minute     int,
  duration_minutes int,
  all_day          boolean     not null default false,
  category_id      text,
  starts_on        date        not null,
  ends_on          date
);

create table tasks (
  id               uuid primary key default gen_random_uuid(),
  title            text        not null,
  date             date        not null,
  start_minute     int,
  duration_minutes int,
  all_day          boolean     not null default false,
  category_id      text,
  done             boolean     not null default false,
  recurrence_id    uuid references recurrences(id) on delete cascade,
  recurrence_date  date,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index tasks_date_idx on tasks (date);

create table recurrence_exceptions (
  recurrence_id uuid not null references recurrences(id) on delete cascade,
  date          date not null,
  primary key (recurrence_id, date)
);

create table settings (
  id                 int primary key default 1 check (id = 1),
  work_start_minute  int   not null default 540,   -- 09:00
  work_end_minute    int   not null default 1080,  -- 18:00
  about_me           text  not null default '',
  categories         jsonb not null
);

insert into settings (id, categories) values (1, '[
  {"id": "work",     "name": "Работа",   "color": "#3b82f6"},
  {"id": "personal", "name": "Личное",   "color": "#a855f7"},
  {"id": "sport",    "name": "Спорт",    "color": "#22c55e"},
  {"id": "health",   "name": "Здоровье", "color": "#ef4444"},
  {"id": "home",     "name": "Дом",      "color": "#f59e0b"}
]'::jsonb);

create table command_log (
  id         uuid primary key default gen_random_uuid(),
  text       text        not null,
  operations jsonb       not null,
  snapshot   jsonb       not null,
  created_at timestamptz not null default now()
);
