-- Владелец у данных. Фазы 1 и 3 разнесены намеренно, см. конец файла.
--
-- Ни drop, ни truncate, ни delete: в базе живое расписание. Колонки
-- добавляются пустыми и заполняются подзапросом, поэтому идентификатор
-- владельца нигде не написан буквально — репозиторий публичный.
--
-- Подзапрос (select id from "user") корректен ровно потому, что на момент
-- миграции строка одна. Если их окажется больше, запрос упадёт — и это
-- правильно: значит предпосылка нарушена и переносить вслепую нельзя.

-- ФАЗА 1 — применяется ДО выкладки нового кода.

alter table tasks              add column user_id text references "user"(id) on delete restrict;
alter table recurrences        add column user_id text references "user"(id) on delete restrict;
alter table command_log        add column user_id text references "user"(id) on delete restrict;
alter table push_subscriptions add column user_id text references "user"(id) on delete cascade;

update tasks              set user_id = (select id from "user");
update recurrences        set user_id = (select id from "user");
update command_log        set user_id = (select id from "user");
update push_subscriptions set user_id = (select id from "user");

create index tasks_user_date_idx        on tasks (user_id, date);
create index recurrences_user_idx       on recurrences (user_id);
create index command_log_user_idx       on command_log (user_id, created_at desc);
create index push_subscriptions_user_idx on push_subscriptions (user_id);

-- Настройки: у старой settings стоит check (id = 1), физически запрещающий
-- вторую строку. Менять ограничение не будем — заводим свою таблицу.
-- Ни одного default: умолчания объявлены один раз в TypeScript
-- (lib/settings-defaults.ts), и вставка всегда несёт явные значения.
create table user_settings (
  user_id               text primary key references "user"(id) on delete restrict,
  work_start_minute     int   not null,
  work_end_minute       int   not null,
  about_me              text  not null,
  categories            jsonb not null,
  timezone              text  not null,
  notify_before_minutes int   not null
);

insert into user_settings (user_id, work_start_minute, work_end_minute, about_me,
                           categories, timezone, notify_before_minutes)
select (select id from "user"), work_start_minute, work_end_minute, about_me,
       categories, timezone, notify_before_minutes
from settings where id = 1;

-- ФАЗА 3 — применяется ПОСЛЕ выкладки и проверки. Не запускать раньше:
-- старый код колонку не заполняет и начнёт падать на каждой вставке.
--
-- alter table tasks              alter column user_id set not null;
-- alter table recurrences        alter column user_id set not null;
-- alter table command_log        alter column user_id set not null;
-- alter table push_subscriptions alter column user_id set not null;
