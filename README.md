# TrialCrew Backend

Fastify + TypeScript + Zod API. Two interchangeable data drivers, selected by `DATABASE_URL`:

- **unset (default)** → in-memory store (`src/store.ts`) — boots with zero setup.
- **set** → **Postgres via Prisma** (`src/prismaRepo.ts`).

The HTTP contract is identical on either driver. `GET /health` reports the active `driver`.

## Run locally (in-memory, no DB)

```bash
npm install
npm run dev        # http://localhost:4000  (driver: memory)
npm run typecheck
```

## Run on Postgres

```bash
cp .env.example .env            # set DATABASE_URL to your Postgres
npm run db:generate             # prisma generate
npx prisma migrate dev --name init   # create + apply the initial migration
npm run db:seed                 # load the demo data
npm run dev                     # driver: postgres
```

Verify: `curl localhost:4000/health` → `"driver":"postgres"`, then any endpoint
(`/me/profile`, `/me/cycles`, `/me/apps`, …) returns the seeded data.

DB scripts: `db:generate` · `db:migrate` (dev) · `db:deploy` (prod) · `db:seed` · `db:push` · `db:studio`.

### Postgres integration test (auth + two-sided connection)

```bash
DATABASE_URL="postgres://…" npx prisma db push   # once
DATABASE_URL="postgres://…" npm run test:pg
```

`scripts/pg-test.ts` is the only **runtime** proof of authorization (the in-memory e2e is
single-user). It seeds 3 users and asserts: a tester's opt-in becomes a founder-visible enrollment
that stays in sync (daily check-in → feedback), vertical matching, and that an attacker gets
404/403 on another user's cycles/apps/emails/broadcasts. DESTRUCTIVE within its own `pgt_*` test
scope — use a throwaway/dev database.

## Contract check (mobile ↔ backend)

```bash
npm run check:contract        # or: node scripts/check-contract.mjs [backendDir] [mobileDir]
```

Static check (no server/DB) that the mobile real client and this backend stay in sync. It fails
(exit 1) if **(1)** a mobile API call's path/method has no matching backend route, or **(2)** a
shared type interface's fields differ between `mobile/src/types` and `backend/src/types.ts`.
Run it in CI for both repos to catch drift automatically.

## Architecture

```
src/
  server.ts      Fastify bootstrap: CORS, JSON errors, /health
  routes.ts      All endpoints (Zod-validated) → call repo.*
  repo.ts        Repo interface (derived from the store) + driver selection
  store.ts       In-memory data + ops (default driver)
  prismaRepo.ts  Postgres data layer (Prisma) — maps rows → API DTOs
  db.ts          PrismaClient singleton
  scheduler/     14-day cadence sweep (pure planner + pg-boss runner + Expo push) — DB-gated
  types.ts       Domain types — mirror of mobile src/types
  config.ts      env (zod)
prisma/
  schema.prisma  PostgreSQL model (App = the unifying campaign entity)
  seed.ts        Demo seed (mirrors the in-memory data)
Dockerfile       Multi-stage; runs `prisma migrate deploy` on start
```

Routes never import a concrete store — they use `repo`, and both implementations
satisfy the same compile-time `Repo` contract. Swapping drivers changes no route code.

## Hosting (the app and backend deploy separately)

The mobile app only needs this service's **public URL** (`EXPO_PUBLIC_API_URL`). Deploy this
folder as its own service. `railway.json` + `Dockerfile` make it work on the first deploy:
the container reads `PORT`/`HOST`, healthchecks `/health`, and on start brings the DB schema up
itself (migrate if migrations exist, else `db push`) — only when `DATABASE_URL` is set.

### Railway

1. **New Project → Deploy from repo** (this folder). Railway uses `railway.json` → the Dockerfile.
2. **In-memory (quick):** no env needed — deploy, open `/health`, done. Data resets per deploy.
3. **Postgres (persistent):** add the **PostgreSQL** plugin → it injects `DATABASE_URL`. Redeploy;
   the schema is created automatically (`db push`). Then **seed once from your machine**
   (the prod image omits `tsx`, so run the seed locally against the Railway DB):
   ```bash
   DATABASE_URL="<railway postgres url>" npm run db:seed
   ```
4. (Optional) add `CLERK_SECRET_KEY` (+ `CLERK_WEBHOOK_SECRET`) to enforce auth, `R2_*` for uploads.

Other Docker platforms (Render, Fly.io, Cloud Run) work the same way via the Dockerfile.

**Env vars:** `DATABASE_URL` (Postgres) · `PORT`/`HOST` (optional) · `CLERK_SECRET_KEY` /
`CLERK_WEBHOOK_SECRET` (auth) · `R2_*` (proof uploads).

## Endpoints (contract)

**Account:** `POST /me/push-token` (store Expo push token) · `POST /me/role` (set founder/tester flags)

**Tester:** `GET /me/profile` · `GET /feedback/questions` · `GET /me/notifications` ·
`POST /me/notifications/read` · `GET /campaigns/matched` · `GET /me/cycles` · `GET /cycles/:id` ·
`POST /campaigns/:id/opt-in` · `POST /cycles/:id/proof/upload-url` (R2 signed PUT) · `POST /cycles/:id/proof` · `POST /cycles/:id/checkins/:day` ·
`POST /cycles/:id/daily-checkin` · `PATCH /cycles/:id/email` · `POST /cycles/:id/feedback` ·
`POST /cycles/:id/claim-reward`

**Founder:** `GET /me/apps` · `GET /apps/:id` · `GET /apps/:id/enrollments` · `GET /apps/:id/emails` ·
`GET /enrollments/:id` · `GET /me/testers` · `GET /me/founder-stats` · `POST /apps` ·
`POST /apps/:id/publish` · `POST /apps/:id/invited` · `POST /testers/:id/rate` · `POST /enrollments/:id/rate`

**Broadcasts:** `GET /broadcasts?packageName=` · `POST /broadcasts` ·
`GET /broadcasts/:id/replies` · `POST /broadcasts/:id/replies`

## Auth (Clerk) — inert until configured

Like the DB driver, auth activates by env. `GET /health` reports `auth: "demo" | "clerk"`.

- **`CLERK_SECRET_KEY` unset (default)** → no enforcement; the data layer uses the seeded demo
  user. Good for local + the in-memory demo.
- **`CLERK_SECRET_KEY` set** → every request (except `/health` and `/webhooks/*`) must carry a
  valid Clerk `Authorization: Bearer <token>`. The token is verified (`@clerk/backend`), the
  User is resolved/created, and its id is put on a request-scoped context so the Prisma layer
  serves *that* user's data. Missing/invalid token → `401`.

**User sync:** `POST /webhooks/clerk` (Svix-verified with `CLERK_WEBHOOK_SECRET`) upserts/deletes
`User` rows on `user.created` / `user.updated` / `user.deleted`. Point a Clerk webhook at it.

Enable: set `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SECRET`, and `DATABASE_URL` (Clerk realistically
pairs with Postgres). The mobile app must then send real Clerk session tokens (its `src/lib/auth`
swaps from the stub to the Clerk Expo SDK).

## Storage (Cloudflare R2) — gated, ready

`POST /cycles/:id/proof/upload-url` returns a short-lived **signed PUT url** + the final public
url (`src/storage.ts`, S3 SDK lazy-loaded). **Inert until R2 env is set** (`R2_ACCOUNT_ID`,
`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_URL`) — returns
`{configured:false}` and the app falls back to the local image. The mobile side (`expo-image-picker`
→ PUT → `POST /cycles/:id/proof`) is wired and activates automatically once R2 is configured.

## Scheduler (14-day cadence) — gated, runs in-process

`src/scheduler/` runs the check-in cadence: with `DATABASE_URL` set, the server boots **pg-boss**
and sweeps every hour — reminding testers when a day-3/7/10/14 check-in is due, marking ones
unanswered past a 2-day grace **MISSED**, and **dropping** the tester (cycle + enrollment) on a
miss, with Expo push + in-app notifications. No `DATABASE_URL` → it's a no-op. On Railway with the
Postgres plugin it activates automatically (same process as the API). The pure cadence rules are
unit-tested without a DB:

```bash
npm run test:sweep
```

## Remaining for production
- **Email/invites** (Resend), proper onboarding (role/vertical), reward fulfillment (billing),
  ops (Sentry / rate-limiting / backups).
