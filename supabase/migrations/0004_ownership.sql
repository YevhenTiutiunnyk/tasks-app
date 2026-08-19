-- Владелец у данных. Фазы 1, 2 и 3 разнесены намеренно, см. комментарии
-- перед каждой.
--
-- Ни drop, ни truncate, ни delete: в базе живое расписание. Колонки
-- добавляются пустыми и заполняются подзапросом, поэтому идентификатор
-- владельца нигде не написан буквально — репозиторий публичный.
--
-- Подзапрос (select id from "user") корректен ровно потому, что на момент
-- миграции строка одна. Один — не «одна или ноль»: при нуле строк подзапрос
-- вернёт NULL, а не ошибку, и update молча проставит NULL вместо отказа.
-- Поэтому предпосылка проверяется явно, до первого использования подзапроса,
-- и проверка ловит оба отклонения — и «больше одной», и «ноль», — а не
-- полагается на побочное свойство скалярного подзапроса.
--
-- Каждая фаза — своя транзакция (begin/commit). В SQL-редакторе Supabase
-- это ничего не меняет: пакет и так уедет одним запросом и откатится
-- целиком при ошибке. Но при запуске через psql -f без -1 каждый оператор
-- коммитится сам по себе, и падение в середине оставило бы колонки
-- добавленными, но незаполненными, — а повторный прогон уже невозможен:
-- alter упрётся в то, что колонка уже есть. Явные границы транзакции делают
-- результат не зависящим от способа запуска.

-- ФАЗА 1 — применяется ДО выкладки нового кода.

begin;

do $$ begin
  if (select count(*) from "user") <> 1 then
    raise exception 'Ожидалась ровно одна строка в "user", найдено %', (select count(*) from "user");
  end if;
end $$;

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
--
-- Сама таблица создаётся здесь, в фазе 1: это структура, а не данные, и
-- старому коду она не мешает — он о ней не знает. Перенос данных в неё —
-- отдельно, в фазе 2, см. ниже.
create table user_settings (
  user_id               text primary key references "user"(id) on delete restrict,
  work_start_minute     int   not null,
  work_end_minute       int   not null,
  about_me              text  not null,
  categories            jsonb not null,
  timezone              text  not null,
  notify_before_minutes int   not null
);

commit;

-- ФАЗА 2 — выполняется непосредственно перед выкладкой нового кода,
-- отдельным шагом от фазы 1.
--
-- Перенос данных в user_settings не может стоять в фазе 1: между фазой 1
-- и выкладкой старый код на бою продолжает работать и пишет в settings —
-- saveTimezone в lib/db.ts делает это при каждой команде с телефона, экран
-- настроек так же. Если перенести данные заранее, всё, что запишется в
-- settings в этом промежутке, потеряется молча: новый код о settings уже
-- не знает и читает только user_settings.
--
-- И перенос не может выполняться после выкладки: к этому моменту новый код
-- уже сам пишет в user_settings, и повторный перенос из settings затёр бы
-- свежие значения старыми. Поэтому фаза 2 — это последний момент перед
-- переключением кода, не раньше и не позже.
--
-- on conflict делает шаг повторяемым: если выкладку отложили и settings
-- успели измениться ещё раз, повторный запуск фазы 2 перенесёт актуальное
-- состояние, а не упадёт на дубликате первичного ключа.

begin;

insert into user_settings (user_id, work_start_minute, work_end_minute, about_me,
                           categories, timezone, notify_before_minutes)
select (select id from "user"), work_start_minute, work_end_minute, about_me,
       categories, timezone, notify_before_minutes
from settings where id = 1
on conflict (user_id) do update set
  work_start_minute     = excluded.work_start_minute,
  work_end_minute       = excluded.work_end_minute,
  about_me              = excluded.about_me,
  categories            = excluded.categories,
  timezone              = excluded.timezone,
  notify_before_minutes = excluded.notify_before_minutes;

commit;

-- ФАЗА 3 — применяется ПОСЛЕ выкладки и проверки. Не запускать раньше:
-- старый код колонку не заполняет и начнёт падать на каждой вставке.
--
-- Бэкфилл перед set not null повторяется не просто так: между фазой 1
-- и выкладкой старый код на бою продолжал вставлять задачи, правила и
-- записи журнала, не зная о новой колонке, — эти строки остались
-- с user_id = null. set not null упадёт на них первым делом, и без этого
-- шага оператор увидит только ошибку ограничения, без объяснения источника.
-- Четыре update — те же, что и в фазе 1: они идемпотентны и безопасны
-- повторить над уже заполненными строками.
--
-- begin;
--
-- update tasks              set user_id = (select id from "user");
-- update recurrences        set user_id = (select id from "user");
-- update command_log        set user_id = (select id from "user");
-- update push_subscriptions set user_id = (select id from "user");
--
-- alter table tasks              alter column user_id set not null;
-- alter table recurrences        alter column user_id set not null;
-- alter table command_log        alter column user_id set not null;
-- alter table push_subscriptions alter column user_id set not null;
--
-- commit;
