-- Ключи пользователей Anthropic. Одна фаза: таблица новая, переносить нечего.
--
-- Колонки ключа допускают NULL намеренно. Строка означает не «у человека есть
-- ключ», а «что мы знаем про его попытки и, если ключ есть, сам ключ»: счётчик
-- неудачных попыток обязан считать у того, у кого ключа ещё нет, — именно он
-- и есть первый перебиратель чужих ключей. При not null считать было бы негде,
-- потому что строку не создать, пока нет ключа.
--
-- Ограничение all_or_nothing запрещает полустрочку: четыре колонки ключа либо
-- все пустые, либо все заполненные. Признак «ключ заведён» —
-- key_ciphertext is not null, а не наличие строки.
--
-- key_set_at, а не created_at с updated_at: строка создаётся при первой
-- попытке, в том числе неудачной, и обычная пара описывала бы жизнь строки,
-- а экрану нужно время действующего ключа. Человек, трижды промахнувшийся
-- в понедельник и заведший ключ в среду, увидел бы «Ключ заведён
-- в понедельник».
--
-- on delete cascade, а не restrict (в отличие от tasks и recurrences): ключ
-- вводится заново одной вставкой, и это секрет, который после удаления
-- учётной записи не должен оставаться в базе. restrict добавил бы вторую
-- причину, по которой delete from "user" откажет, не защищая ничего ценного.

begin;

create table user_api_keys (
  user_id         text        primary key references "user"(id) on delete cascade,
  key_iv          bytea,
  key_tag         bytea,
  key_ciphertext  bytea,
  key_set_at      timestamptz,
  failed_attempts int         not null,
  locked_until    timestamptz,
  constraint user_api_keys_all_or_nothing check (
    (key_iv is null)         = (key_ciphertext is null)
    and (key_tag is null)    = (key_ciphertext is null)
    and (key_set_at is null) = (key_ciphertext is null)
  )
);

commit;
