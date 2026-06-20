# TrialCrew Backend — Project Context

Fastify + TypeScript + Zod API for **TrialCrew** (see `../mobile` for the app + product domain).
Implements the exact contract the mobile app's API defines (`../mobile/src/api/realClient.ts`).

## Two data drivers (selected by `DATABASE_URL`)
- **unset → in-memory** (`src/store.ts`): boots with zero setup; data resets on restart.
- **set → Postgres/Prisma** (`src/prismaRepo.ts`): persistent.

`src/repo.ts` derives the `Repo` interface from the in-memory store and picks the impl at load
(top-level await). **Both impls satisfy the same compile-time contract** — routes only ever call
`repo.*`. `GET /health` reports the active `driver`.

## Auth (Clerk) — also env-gated (`src/auth.ts`)
- **`CLERK_SECRET_KEY` unset → demo**: no enforcement; repo uses the seeded demo user.
- **set → clerk**: root `onRequest` hook verifies the Bearer token (`@clerk/backend`), resolves/
  upserts the `User`, and `userStore.enterWith(user)` (AsyncLocalStorage, `src/context.ts`) so
  `prismaRepo` serves that user. `/health` + `/webhooks/*` + `OPTIONS` bypass. Webhook
  `POST /webhooks/clerk` (Svix) syncs users.
- **Gotcha:** `setupAuth(app)` is called **directly on the root instance** (NOT `register()`'d) —
  an encapsulated plugin's onRequest hook wouldn't apply to the sibling routes plugin.

Single-tenant **demo** (default): one seeded user "Sam Rivera" (`sam.rivera@example.com`), both
tester and founder.

## Domain modeling note
`App` is the **unifying entity**: a founder owns it; testers browse **published** apps
(`status = ENROLLING`) they don't own and opt in → `Cycle`. So "Campaign" (browse) and
"FounderApp" are two **projections of `App`** (see mappers in `prismaRepo.ts`). Tester/author
display fields are denormalized onto `Enrollment` / `BroadcastReply` so the demo seed needs no
per-tester `User` rows.

## The two sides are connected (Prisma layer — `linkEnrollment`)
Opt-in is **two-sided**: `optIn` creates the tester's `Cycle` AND a founder-visible `Enrollment`
on the same `App` (linked via `Cycle.enrollmentId`), denormalizing the tester's name/badge/score.
The founder's cohort stays live: `dailyCheckIn` syncs `Enrollment.dailyDone`; `submitFeedback`
flips it to `COMPLETED`/`feedbackSubmitted`. `getBrowseCampaigns` also does **basic matching** —
apps in the tester's `vertical` sort first. (In-memory store is the single-user demo and keeps the
old split projections — the connection only matters under Postgres.)

## Authorization (Prisma layer — do NOT weaken)
`prismaRepo` enforces ownership so a caller can only touch their own data (prevents IDOR):
- Cycle ops (`getCycle`, proof, check-ins, daily, email, feedback, claim) go through
  `ownCycleOrThrow(id, uid)` → `findFirst({ where: { id, testerId: uid } })`.
- App ops (`getFounderApp`, `publish`, `markInvited`, `getEnrollments`, `exportEmails`) go through
  `ownAppOrThrow(id, uid)` (`founderId` scope). Enrollment ops via `ownEnrollmentOrThrow`
  (`app.founderId` scope).
- `sendBroadcast` requires the caller to OWN an app on that package; `postReply` **derives**
  authorName/authorRole from the authenticated user (never trusts the client) and requires the
  caller to be the founder or an enrolled tester.
Never replace these with bare `findUnique({ where: { id } })`. (The in-memory store is single
demo-user, so it has no guards — guards only matter under Postgres + Clerk.)

## Scheduler (14-day cadence — `src/scheduler/`)
Env-gated like everything else: no `DATABASE_URL` → no-op. With Postgres, `startScheduler()`
(called from `server.ts` `main()`) boots **pg-boss** and runs `cycle-sweep` hourly.
- `sweep.ts` — **pure** `planCycleSweep(cycle, now)`: PENDING+due → remind (mark SENT),
  unanswered past `MISS_GRACE_MS` (2d) → MISSED, any miss → drop. Idempotent. Unit-tested with
  **no DB** (`scripts/sweep-test.ts`, `npm run test:sweep`).
- `runner.ts` — `runSweepOnce(now?, scope?)`: loads ACTIVE cycles, applies each plan in a txn
  (check-in status + cycle/enrollment `DROPPED` together + `Notification` rows), then delivers
  pushes. `scope.testerId` narrows the sweep (tests use it to stay isolated).
- `push.ts` — Expo push over `fetch` (no SDK dep); inert without a token; never throws.
- `index.ts` — pg-boss wiring; lazy-imports pg-boss + runner so memory mode never loads Prisma.
**Writes go through transactions** (`optIn`/`dailyCheckIn`/`submitFeedback`/`claimReward` and the
sweep) — helpers (`ownCycleOrThrow`/`linkEnrollment`) take an optional `Db` (tx client).

## Conventions
- Errors: `throw Object.assign(new Error(msg), { statusCode })` → handler renders `{ error }`.
- `types.ts` mirrors `mobile/src/types` — keep in sync.
- After editing `prisma/schema.prisma`: `npm run db:generate` (regenerates the typed client →
  `prismaRepo.ts` typechecks against it). The seed (`prisma/seed.ts`) lives outside `src/` so the
  main `tsc` skips it — check it with a standalone `tsc` if you change it.
- Endpoint paths must match `mobile/src/api/realClient.ts`.

## Verification
- **No DB (here):** Prisma layer is verified by `prisma validate` + `prisma generate` + `tsc`
  (queries typecheck against the generated client); the in-memory server is run via `test:e2e`;
  the pure cadence planner is unit-tested via `test:sweep`.
- **With a DB (runtime proof of auth + the connection + the sweep):** `npm run test:pg` against a real
  `DATABASE_URL` (`scripts/pg-test.ts`). It seeds 3 users and asserts the two-sided connection
  AND the IDOR guards (an attacker gets 404/403 on others' cycles/apps/emails). The in-memory
  e2e is single-user so it CANNOT exercise these — `test:pg` is the only runtime proof of
  authorization. DESTRUCTIVE within its own `pgt_*` scope → use a throwaway/dev DB.

## Hosting
Deploys as its own service (Dockerfile runs `prisma migrate deploy` then the server). The mobile
app only needs the public URL. See README → Hosting.
