-- Пуш-уведомления: напоминание перед началом задачи.
--
-- Миграция только добавляет. Ни drop, ни truncate, ни create table if not
-- exists: в базе лежит живое расписание, и повторное применение должно
-- упасть с ошибкой, а не «починить» схему, снеся данные.
--
-- Таблицы tasks и recurrences не затрагиваются ни одним оператором.

create table push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  endpoint   text        not null unique,
  p256dh     text        not null,
  auth       text        not null,
  created_at timestamptz not null default now()
);

-- Ключ — это task.id. Разбирать случаи не нужно: у раскрытых вхождений серии
-- идентификатор уже имеет вид occ:<правило>:<дата>, то есть уникален для пары
-- «правило, дата», и отметка об одном вхождении не глушит следующее.
create table notifications_sent (
  key     text        primary key,
  sent_at timestamptz not null default now()
);

-- Планировщик работает без браузера, а часовой пояс до сих пор приходил
-- только от клиента при каждой команде. Теперь он хранится здесь, и клиент
-- обновляет его при отправке команды с телефона.
alter table settings add column timezone text not null default 'Europe/Amsterdam';

alter table settings add column notify_before_minutes int not null default 15;
