-- Закрыть схему public от REST API Supabase.
--
-- ПОЧЕМУ ЭТО ДЫРА
--
-- Supabase сам публикует каждую таблицу схемы public через PostgREST,
-- а роли anon и authenticated по умолчанию получают на них все права.
-- Ключ anon секретом не считается: он задуман для браузера. Без RLS
-- любой, у кого он есть, читал бы и писал напрямую, мимо приложения:
-- session (токены сессий — вход под чужим именем), account (OAuth-токены
-- Google), user_api_keys, задачи всех владельцев.
--
-- ПОЧЕМУ ПРИЛОЖЕНИЕ ЭТОГО НЕ ЗАМЕТИТ
--
-- Приложение ходит в базу ролью postgres по DATABASE_URL, у неё
-- rolbypassrls = true, и она же владелец таблиц. RLS без политик для неё
-- ничего не меняет, а для anon и authenticated означает «ни одной строки».
-- PostgREST приложение не использует вовсе.
--
-- ПОЧЕМУ ЦИКЛОМ, А НЕ СПИСКОМ
--
-- В базе живут и таблицы, которых нет в миграциях: резервные копии
-- tasks_backup_* и settings_backup_*, снятые руками перед переносом
-- данных. В них те же задачи, и забыть их было бы так же плохо, как
-- забыть tasks. Цикл берёт всё, что есть в схеме на момент запуска.
--
-- Роли anon и authenticated есть только в Supabase — в локальной
-- тестовой базе их нет, и revoke там упал бы. Отсюда проверка pg_roles.

begin;

do $$
declare
  t record;
  supabase_roles boolean := exists (select 1 from pg_roles where rolname = 'anon')
                        and exists (select 1 from pg_roles where rolname = 'authenticated');
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
    if supabase_roles then
      execute format('revoke all on table public.%I from anon, authenticated', t.tablename);
    end if;
  end loop;

  -- Таблицы, которые появятся позже, тоже не должны открываться наружу
  -- сами собой: снимаем права по умолчанию, которые раздаёт Supabase.
  if supabase_roles then
    alter default privileges in schema public revoke all on tables from anon, authenticated;
    alter default privileges in schema public revoke all on sequences from anon, authenticated;
    alter default privileges in schema public revoke all on functions from anon, authenticated;
  end if;
end $$;

commit;
