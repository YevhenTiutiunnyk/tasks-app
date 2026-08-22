#!/usr/bin/env bash
# Пересоздаёт тестовый контейнер tasks-test-db и накатывает схему ровно тем
# способом, каким она сейчас собрана в живом контейнере: настоящими
# миграциями по порядку, с временной строкой в "user" ради предохранителя
# в 0004 (см. supabase/migrations/0004_ownership.sql — «ровно одна строка»)
# и её удалением сразу после.
#
# Схему нельзя ни скопировать с боевой базы, ни написать руками: единственный
# источник правды — файлы миграций. Если завтра миграцию применят только
# к одной из двух баз, расхождение должно вылезти на тестах, а не спрятаться
# за ручной копией схемы.
#
# Идемпотентен: контейнер каждый раз сносится и поднимается заново, поэтому
# повторный запуск гарантированно даёт чистую базу на нуле строк, а не
# накопленный мусор от прошлых прогонов (задача создана как раз потому,
# что мутационные тесты дважды оставляли мусор в боевой базе).
set -euo pipefail

CONTAINER=tasks-test-db
PORT=55432
DB=tasks_test
PGUSER=postgres
PGPASSWORD=testpass
IMAGE=postgres:17

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="$SCRIPT_DIR/../supabase/migrations"

echo "== Пересоздаю контейнер $CONTAINER =="
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --name "$CONTAINER" \
  -e POSTGRES_PASSWORD="$PGPASSWORD" \
  -e POSTGRES_DB="$DB" \
  -p "$PORT:5432" \
  "$IMAGE" >/dev/null

echo "== Жду готовности Postgres =="
ready=0
for _ in $(seq 1 30); do
  if docker exec "$CONTAINER" pg_isready -U "$PGUSER" -d "$DB" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "Postgres не поднялся за 30 секунд" >&2
  exit 1
fi

psql_exec() {
  docker exec -i "$CONTAINER" psql -U "$PGUSER" -d "$DB" -v ON_ERROR_STOP=1 "$@"
}

echo "== Миграции 0001-0003 =="
for f in 0001_init.sql 0002_push.sql 0003_auth.sql; do
  echo "  -> $f"
  psql_exec < "$MIGRATIONS_DIR/$f"
done

# 0004 несёт предохранитель «ровно одна строка в "user"» (он защищает
# боевую базу от применения update-подзапроса на пустой или многолюдной
# таблице). На свежесобранной тестовой базе строк ноль, поэтому без
# временного пользователя предохранитель честно сработал бы и здесь.
# У строки нет ни задач, ни правил, ни записей в журнале — она существует
# ровно на время миграции и удаляется сразу после, до первого настоящего
# теста.
echo "== Временная строка для предохранителя 0004 =="
psql_exec <<'SQL'
insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
values ('seed', 'seed', 'seed@example.invalid', false, now(), now());
SQL

echo "== Миграция 0004 (фаза 1; фазы 2 и 3 закомментированы и не выполнятся) =="
psql_exec < "$MIGRATIONS_DIR/0004_ownership.sql"

echo "== Удаляю временную строку =="
psql_exec <<'SQL'
delete from "user" where id = 'seed';
SQL

echo "== Миграция 0005 =="
psql_exec < "$MIGRATIONS_DIR/0005_user_keys.sql"

tables=$(docker exec "$CONTAINER" psql -U "$PGUSER" -d "$DB" -tAc \
  "select count(*) from information_schema.tables where table_schema = 'public'")
echo "== Готово: таблиц в public — $tables =="
