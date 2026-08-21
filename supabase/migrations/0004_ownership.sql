-- Владелец у данных. Фазы 1, 2 и 3 разнесены намеренно, см. комментарии
-- перед каждой.
--
-- Ни drop, ни truncate, ни delete: в базе живое расписание. Колонки
-- добавляются пустыми и заполняются подзапросом, поэтому идентификатор
-- владельца нигде не написан буквально — репозиторий публичный.
--
-- Подзапрос (select id from "user") корректен ровно потому, что на момент
-- выполнения строка одна. Один — не «одна или ноль»: при нуле строк
-- подзапрос вернёт NULL, а не ошибку, и update молча проставит NULL вместо
-- отказа. Поэтому предпосылка проверяется явно, до первого использования
-- подзапроса, и проверка ловит оба отклонения — и «больше одной», и
-- «ноль», — а не полагается на побочное свойство скалярного подзапроса.
-- Тот же предохранитель стоит в начале каждой фазы, которая читает этот
-- подзапрос: пользователей может стать больше между фазами, и падать нужно
-- с внятным сообщением, а не с «more than one row returned by a subquery»
-- или, того хуже, молча.
--
-- Каждая фаза — своя транзакция (begin/commit), и это не декоративно.
--
-- Если выделить несколько операторов без явного begin/commit и выполнить
-- разом, Postgres в SQL-редакторе Supabase сам оборачивает их в одну
-- неявную транзакцию — но ровно до первого явного commit. commit в конце
-- фазы 1 закрывает транзакцию по-настоящему: ошибка в другой фазе фазу 1
-- уже не откатит, потому что откатывать к этому моменту нечего — она уже
-- зафиксирована. По той же причине явный begin, встреченный внутри уже
-- открытой (пусть и неявной) транзакции, даст лишь предупреждение
-- «there is already a transaction in progress», а не полноценную
-- вложенность.
--
-- При запуске через psql -f непомеченный оператор в отсутствие begin/commit
-- коммитится сам по себе; begin/commit внутри фазы всё равно держат её как
-- единое целое. Но без флага -v ON_ERROR_STOP=1 psql после ошибки в одной
-- фазе не останавливается, а продолжает со следующего оператора, — флаг
-- обязателен, если миграцию прогоняют через psql, а не вставляют
-- в редактор целиком.
--
-- Фазы 2 и 3 ниже намеренно закомментированы целиком, а не только их
-- «опасная» часть: если выделить файл целиком и нажать «выполнить»,
-- физически выполнится только фаза 1 — после её commit всё остальное
-- для Postgres просто текст под `--`, а не операторы, которые можно
-- случайно прогнать раньше времени.

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

-- ФАЗА 2 — раскомментировать и выполнить непосредственно перед выкладкой
-- нового кода, и ни секундой раньше.
--
-- Закомментирована целиком, а не только описана словами: между фазой 1
-- и выкладкой проходят часы или дни, а старый код всё это время пишет
-- в settings при каждой команде с телефона (saveTimezone в lib/db.ts)
-- и с экрана настроек. Выполни фазу 2 раньше срока — и всё, что запишется
-- в settings после, потеряется молча, а по симптому это будет выглядеть
-- как «настройки сбросились». Естественная реакция на такой симптом —
-- «допрогнать миграцию», то есть выполнить фазу 2 ещё раз, уже после
-- выкладки, когда новый код сам пишет в user_settings, — и это затрёт
-- свежие данные старыми. insert ... on conflict при этом отработает как
-- «INSERT 0 1», без единой ошибки или предупреждения: прозы «не раньше
-- и не позже» тут недостаточно, поэтому фаза физически не выполнится сама
-- по себе — её нужно осознанно раскомментировать.
--
-- on conflict делает шаг повторяемым на случай, если выкладку отложили
-- и settings успели измениться ещё раз: повторный запуск фазы 2 (всё ещё
-- до выкладки) перенесёт актуальное состояние, а не упадёт на дубликате
-- первичного ключа.
--
-- Предохранитель «ровно одна строка» — тот же, что в фазе 1, и не лишний:
-- вход через Google уже открыт, и за часы или дни между фазой 1 и фазой 2
-- может появиться второй пользователь. Без предохранителя подзапрос упал
-- бы с «more than one row returned by a subquery» прямо в момент выкладки;
-- с ним — с понятным сообщением заранее.
--
-- begin;
--
-- do $$ begin
--   if (select count(*) from "user") <> 1 then
--     raise exception 'Ожидалась ровно одна строка в "user", найдено %', (select count(*) from "user");
--   end if;
-- end $$;
--
-- insert into user_settings (user_id, work_start_minute, work_end_minute, about_me,
--                            categories, timezone, notify_before_minutes)
-- select (select id from "user"), work_start_minute, work_end_minute, about_me,
--        categories, timezone, notify_before_minutes
-- from settings where id = 1
-- on conflict (user_id) do update set
--   work_start_minute     = excluded.work_start_minute,
--   work_end_minute       = excluded.work_end_minute,
--   about_me              = excluded.about_me,
--   categories            = excluded.categories,
--   timezone              = excluded.timezone,
--   notify_before_minutes = excluded.notify_before_minutes;
--
-- commit;

-- ФАЗА 3 — применяется ПОСЛЕ выкладки и проверки. Не запускать раньше:
-- старый код колонку не заполняет и начнёт падать на каждой вставке.
--
-- Бэкфилл здесь — не про «пройтись ещё раз по всем строкам», а именно про
-- осиротевшие: между фазой 1 и выкладкой старый код на бою продолжал
-- вставлять задачи, правила и записи журнала, не зная о новой колонке, —
-- эти строки остались с user_id = null. where user_id is null — не
-- оптимизация, а необходимость: без него оператор, чинящий провалившийся
-- set not null, переписал бы и уже принадлежащие кому-то строки, а не
-- только ничьи. Фаза 3 идёт после выкладки многопользовательской
-- функциональности, то есть именно тогда, когда мог появиться второй
-- настоящий пользователь, — и безопасность здесь держится не на
-- «идемпотентности», а на том, что оператор трогает исключительно строки
-- без владельца.
--
-- Тот же предохранитель «ровно одна строка», что в фазах 1 и 2: если
-- к моменту фазы 3 пользователей уже несколько, автоматически решить, кому
-- принадлежат осиротевшие строки, нельзя — пусть падает с понятным
-- сообщением, и оператор разбирает владельца вручную, а не получает такую
-- строку себе по умолчанию.
--
-- begin;
--
-- do $$ begin
--   if (select count(*) from "user") <> 1 then
--     raise exception 'Ожидалась ровно одна строка в "user", найдено %', (select count(*) from "user");
--   end if;
-- end $$;
--
-- update tasks              set user_id = (select id from "user") where user_id is null;
-- update recurrences        set user_id = (select id from "user") where user_id is null;
-- update command_log        set user_id = (select id from "user") where user_id is null;
-- update push_subscriptions set user_id = (select id from "user") where user_id is null;
--
-- alter table tasks              alter column user_id set not null;
-- alter table recurrences        alter column user_id set not null;
-- alter table command_log        alter column user_id set not null;
-- alter table push_subscriptions alter column user_id set not null;
--
-- commit;
