# Working in this repo

## Database migrations (server/, Prisma + SQLite, deployed on Render)

This app ships to a single production Render web service with **no staging
environment** and a SQLite file on a persistent disk — there is no safety
net between `git push` and a real user hitting a broken schema. On
2026-10-10, a migration that added `NOT NULL` columns to `VaultUserKey`
without a default broke production: it had tested cleanly against a fresh
local `dev.db`, but by the time it shipped, a real row already existed in
that table from testing the *previous* deploy. The service crash-looped
(`prisma migrate deploy` failing with P3018, then every subsequent boot
failing with P3009 "failed migrations block new ones") until it was fixed
by hand through Render's Shell/One-Off Jobs. Avoid repeating this:

- **Never add a required (`NOT NULL`, no default) column, or any other
  change that fails against existing rows, to a table that could already
  hold production data.** If the table is new (no migration before this
  one ever created it), it's safe. Otherwise:
  - Prefer additive, backward-compatible changes: add the column nullable,
    backfill it (in the same migration via SQL, or in application code),
    *then* tighten to `NOT NULL` in a later migration once every row is
    known to satisfy it.
  - If a destructive/breaking change is genuinely the right call (e.g. the
    old data is cryptographically meaningless under a new scheme, as
    happened here), **ask the user to confirm there's no real data to lose
    — every single time**, even if they confirmed it for an earlier
    migration on the same feature. A confirmation only covers the data
    that existed *at that moment*; once a feature has shipped once, assume
    someone may have used it for real before your next push.
- **Before pushing any migration that touches an existing table, test it
  against a database that already has a row in every table it modifies —
  not just a fresh empty `dev.db`.** A clean apply against an empty
  database proves nothing about production. The quick way to do this
  locally (no extra tooling needed — `node:sqlite` is built in to modern
  Node):
  1. Apply all migrations *up to but not including* the new one into a
     throwaway scratch DB (`DATABASE_URL="file:/path/to/scratch.db" npx
     prisma migrate deploy`, with the new migration's folder temporarily
     moved out of `prisma/migrations/`).
  2. Insert a row into whatever table the new migration is about to alter,
     using `node:sqlite`'s `DatabaseSync` with raw SQL (not Prisma
     Client — it's generated from the *new* schema and will refuse to
     write the *old* shape).
  3. Move the new migration back in and run `prisma migrate deploy` against
     that scratch DB. It must succeed before you push.
- **SQLite's `RedefineTables` pattern (the `CREATE TABLE "new_X" ... DROP
  TABLE X ... RENAME` dance Prisma generates for SQLite schema changes) is
  not atomic across a failure.** If a migration fails partway through, it
  can leave an orphaned `new_X` table behind, which will make a *later,
  fixed* version of that same migration fail differently (`table "new_X"
  already exists`) when retried. A migration you're hand-fixing after a
  failed deploy should defensively `DROP TABLE IF EXISTS new_X;` for every
  table it redefines, not assume a clean slate.

### If a migration does break production anyway

Symptom: Render shows the deploy as failed, logs show `P3018` (this
migration failed) immediately followed on the next boot by `P3009` ("found
failed migrations, new migrations will not be applied") — this repeats on
every auto-restart, forever, until resolved by hand. There is no
self-healing; pushing a fixed migration file alone is **not** enough.

1. The service's Shell tab usually can't attach while it's crash-looping
   (the cursor blinks but accepts no input) — use **One-Off Jobs** instead,
   or temporarily change the service's Start Command (Settings → Start
   Command) from `npx prisma migrate deploy && npm start` to just `npm
   start` and save, so a stable instance comes up and Shell can attach.
2. Once you have a working shell/job against the service:
   ```
   npx prisma migrate resolve --rolled-back <migration_name>
   npx prisma migrate deploy
   ```
3. If step 2's `migrate deploy` fails with "table already exists", drop the
   orphaned `new_<Table>` table(s) first (see above), then repeat step 2 —
   note `migrate resolve` must be run again for the newest failed attempt
   each time, since every failed `migrate deploy` run adds its own failed
   record.
4. Once `npx prisma migrate deploy` reports success, restore the Start
   Command to `npx prisma migrate deploy && npm start` if you changed it.

## Workflow conventions carried over from prior sessions

- Build the real feature, not a mockup; verify it live (Playwright against
  locally-run dev servers) before calling it done.
- **Never commit or push without the user's explicit "пушни го"** — this
  holds even when a stop-hook or other automated check nudges toward
  committing.
