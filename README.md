# Schedule

*[Русская версия](README.ru.md)*

A personal weekly schedule where you never fill in a form. You dictate a phrase —
*"doctor on Wednesday at 10"*, *"gym every Tuesday at 8"*, *"move the gym to
Thursday"* — Claude turns it into concrete operations on the schedule, the
operations are applied to the database in a single transaction, and the screen
updates.

The whole app is built around one moment: take out your phone, say the thing, put
the phone away. That constraint drove every decision below, from how the model's
output is treated to what a task block shows.

**There is no speech recognition in the app.** The command bar is an ordinary text
input. Dictation is done by whatever tool the user already has — the author uses
Glaido, which pastes the recognized text into the focused field; the system
keyboard's dictation works just as well. The same goes for the clarification
dialog: its inputs take dictated text too. Staying out of the speech business
keeps the app small and makes it independent of any one platform's audio API.

Next.js 16 · TypeScript · Postgres (Supabase) · Anthropic API · Tailwind · Vitest

> The interface and code comments are in Russian — it is a single-user app built
> for its owner.

---

## What might be worth a look

**The model never touches the database.** A validation layer sits between parsing
and writing (`lib/validate.ts`). It rejects operations that reference tasks which
do not exist, impossible dates, times outside the day, invented categories. Model
output is untrusted input, exactly like a form submission, and the code treats it
that way. Rejected operations don't vanish silently either: the reason is shown in
the UI, because the model itself doesn't know about the rejection and will happily
report success.

**A batch applies completely or not at all.** `lib/apply.ts` opens one transaction
for every operation in a phrase and records a "before" snapshot along the way.
That is where the eight-second **Undo** comes from: the rollback restores state
from the snapshot instead of trying to compute inverse operations. The snapshot is
walked in reverse — otherwise a batch that touched the same task twice would
restore it to an intermediate state rather than the original.

**Dates are strings, time is minutes.** There is not a single `Date` object in the
business logic or the database: `'2026-08-06'` and 840 minutes past midnight. This
removes an entire class of bugs where a DST shift or the server's timezone moves a
task to the neighbouring day.

**Recurrence expansion is a pure function.** `lib/recurrence.ts` turns a rule plus
a list of exceptions into concrete occurrences without touching the database, so
it is covered by ordinary unit tests. Editing a single occurrence materializes it
into a real task and adds an exception — the rule itself stays untouched.

**Direct Postgres instead of the Supabase client.** The Data API is disabled on
purpose: `supabase-js` cannot do real transactions, and without them a rollback
degenerates into a sequence of individual requests, any of which may not land.

**Structured outputs with a zod schema.** The model's response schema and the
validator are deliberately separate (`lib/schema.ts`, `lib/validate.ts`). Every
field is required and nullable, because structured outputs demand that every
property appear in `required`.

---

## How it is put together

| Layer | Files | Responsible for |
| --- | --- | --- |
| Date arithmetic | `lib/dates.ts` | Week boundaries, weekdays, rejecting impossible dates |
| Recurrence | `lib/recurrence.ts` | Rule + exceptions → occurrences; pure function |
| Schema & validation | `lib/schema.ts`, `lib/validate.ts` | Shape of the model's answer, rejection of bad operations |
| Apply & undo | `lib/apply.ts` | Transaction, snapshot, batch rollback |
| Model calls | `lib/parse.ts`, `lib/parse-clarify.ts` | The only places that know about Anthropic |
| Data access | `lib/db.ts`, `lib/week.ts` | Queries and week assembly |
| HTTP | `app/api/*` | Nine routes: week, command, clarify, undo, task, settings, push, notify, auth |
| UI | `app/page.tsx`, `components/*` | Grid, day feed, task card, command bar |

Wide screens get a week grid with an hour ruler; narrow ones get a day feed. The
visible hour range is derived from working hours and then stretched to fit the
week's actual tasks, so a 6 a.m. run is not drawn on top of the header.

When the model understands *what* but not *when*, it creates the task as all-day
and returns a question. The clarification dialog takes another dictated phrase in
the same way — *"tomorrow at 8, one hour"* — and a per-task toggle for "leave it
as all-day".

---

## Tests

```bash
npx vitest run                                                   # no database: DB-backed tests skip
node --env-file=.env.local ./node_modules/vitest/vitest.mjs run   # everything: 182 passing, 7 skipped
```

DB-backed tests (`lib/db.test.ts`, `lib/apply.test.ts`, `lib/ownership.test.ts`,
`lib/allowed-emails.test.ts`) run against a disposable Postgres in Docker — never
against production. Cleanup in all of them is scoped to their own rows (by owner id
or by the `zz-`/`.invalid` test addresses), so pointing them at the wrong database
would be wrong, not destructive — but `vitest.setup.ts` refuses to start at all if
`DATABASE_URL` is set without a `TEST_DATABASE_URL` on a loopback or private
address, so that mistake isn't one you can actually make.

```bash
scripts/test-db.sh   # (re)creates the container tasks-test-db on port 55432
```

The script is idempotent: it drops and recreates the container every run, so a
stale or half-migrated test database is never a state you have to debug, only one
you re-run the script out of. The schema is never copied from production and never
hand-written — the script replays the real files from `supabase/migrations/` in
order, the same way production's schema was built, so a migration applied to only
one of the two databases shows up as a test failure instead of staying invisible.

Add to `.env.local`:

```
TEST_DATABASE_URL=postgresql://postgres:testpass@127.0.0.1:55432/tasks_test
```

`vitest.setup.ts` runs before any test file's own imports and points
`DATABASE_URL` at `TEST_DATABASE_URL` — this has to happen before `lib/db.ts` is
imported, because it opens its connection pool at module load time, not lazily.
The setup file also refuses to run at all if `DATABASE_URL` is set but
`TEST_DATABASE_URL` is missing, unparseable, or not a loopback/private address,
so a lost or mistyped test variable fails loudly instead of quietly falling
through to production.

The main condition is deliberately not "different from production" but "on this
machine or its private network". Comparing against the production URL cannot be
made trustworthy: one Supabase database is handed out under two different host
names — `db.<ref>.supabase.co:5432` directly and
`aws-0-<region>.pooler.supabase.com:6543` through the pooler — and both sit next
to each other in the project dashboard, so pasting the "other" one into
`TEST_DATABASE_URL` is the most believable mistake there is. A production address
is public by definition and fails the loopback/private rule in whatever form it
is written. A secondary check still parses both URLs and refuses when host and
database name match (the port is ignored on purpose: 5432 and 6543 are two doors
into the same Supabase database).

The apply/undo tests run against a real Postgres rather than mocks: they assert on
table contents after the transaction and after the rollback. That Postgres is the
local container, so the whole suite takes 2.4–2.5 seconds. The raised per-test
timeout in `vitest.config.ts` is a leftover from when these tests went to the
production database over the network; it stays as cheap headroom for a cold
container, being a ceiling rather than a delay.

Seven live parsing examples are kept separate. They call the real API, cost money,
and are skipped by default:

```bash
RUN_LLM_TESTS=1 node --env-file=.env.local ./node_modules/vitest/vitest.mjs run lib/parse.examples.test.ts
```

They are the reason a contradiction surfaced at all: a prompt rule forbade creating
a task when no day was given, while the clarification dialog had been designed for
exactly that case.

---

## Running locally

The migrations are applied in two goes, with the first login in between. That is
not a quirk of the instructions but a property of `0004_ownership.sql`: phase 1
of it starts with a guard that refuses to run unless the `"user"` table holds
exactly one row, and it fills the new owner columns from `(select id from
"user")`. On a brand-new database that table is empty until somebody logs in, so
the migration has to come after the first login, not before it.

1. `npm install`
2. Copy `.env.local.example` to `.env.local` and fill it in.
3. Apply the first three migrations from `supabase/migrations/` in the Supabase
   SQL editor, in order: `0001_init.sql`, `0002_push.sql`, `0003_auth.sql`.
   Stop there — `0004_ownership.sql` is step 6.
4. Add your own Google address to the whitelist, in lower case — without this
   row nobody can log in, and the login page says nothing about why:

   ```sql
   insert into allowed_emails (email) values ('you@example.com');
   ```

5. `npm run dev`, open the app and sign in with Google. This creates your row in
   `"user"`. The schedule itself does not work yet — the owner columns and the
   `user_settings` table do not exist — and that is expected at this point.

   ⚠️ Between this step and the next one, keep the app to yourself. A row in
   `"user"` is created by **any** Google sign-in attempt, including one the
   whitelist turns away: the allow check runs on session creation, i.e. after
   Better Auth has already inserted the user (`lib/auth.ts`,
   `databaseHooks.session.create.before`). The outsider gets no session but does
   leave a row behind — and phase 1's guard then refuses to run: "Ожидалась
   ровно одна строка в "user", найдено 2". Fix it by deleting the extra rows
   before applying the migration (sessions and provider links cascade away):

   ```sql
   delete from "user" where email <> 'you@example.com';
   ```

6. Apply **phase 1** of `0004_ownership.sql`: everything from the top of the file
   down to its `commit;`. It adds the `user_id` columns, assigns every existing
   row to the one user found in `"user"`, and creates `user_settings`.

   Phases 2 and 3 further down that file are commented out on purpose and stay
   that way here: phase 2 carries the old single-row `settings` table into
   `user_settings`, and phase 3 backfills rows written by the pre-ownership code
   while it was still deployed. A fresh database has neither of those, which is
   why `scripts/test-db.sh` also replays phase 1 only.

7. Reload the app — the schedule works, and everything you create from now on
   belongs to your user.

| Variable | What it is |
| --- | --- |
| `ANTHROPIC_API_KEY` | Key from console.anthropic.com |
| `DATABASE_URL` | Supabase **transaction pooler**, port **6543** |
| `BETTER_AUTH_URL` | Base URL of the app, used for OAuth callbacks |
| `BETTER_AUTH_SECRET` | Random string, 32+ characters, used by Better Auth |
| `GOOGLE_CLIENT_ID` | OAuth client ID from Google Cloud Console |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret from Google Cloud Console |

Login is Google OAuth via Better Auth (`lib/auth.ts`); only addresses listed in
the `allowed_emails` table can get a session (`lib/allowed-emails.ts`).

The port matters: on a direct connection (5432) serverless functions exhaust the
connection limit. For the same reason the pool is created with `prepare: false` —
the transaction pooler does not support prepared statements.

Before shipping:

```bash
npx tsc --noEmit && npx eslint . && npm run build
```

---

## Deployment

Deployed on Vercel. `vercel.json` pins functions to `fra1`, next to the database in
`eu-central-1`: a single phrase-parsing request makes more than fifteen database
round trips, and crossing the Atlantic for each of them would add roughly a second
for nothing.

