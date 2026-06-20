/**
 * Postgres integration test — proves what the in-memory e2e CANNOT:
 *   (#1) Authorization / IDOR — a user can only touch their OWN data.
 *   (#2) The two sides are connected — a tester's opt-in becomes a founder-visible
 *        Enrollment, and stays in sync as the tester checks in / submits feedback.
 *
 * Requires a REAL Postgres. This is DESTRUCTIVE within its own `pgt_*` test scope
 * (it deletes and recreates those rows) — point it at a throwaway/dev database.
 *
 *   DATABASE_URL="postgres://…" npx prisma db push     # once, to create the schema
 *   DATABASE_URL="postgres://…" npx tsx scripts/pg-test.ts
 *
 * Exits non-zero on any failed assertion.
 */
import { prisma } from "../src/db.js";
import { prismaRepo as repo } from "../src/prismaRepo.js";
import { userStore } from "../src/context.js";

if (!process.env.DATABASE_URL) {
  console.error("✗ DATABASE_URL is not set — this test needs a real Postgres.");
  process.exit(2);
}

// ── tiny assert harness ──────────────────────────────────────────────────────
let pass = 0, failc = 0;
const ok = (n: string) => { pass++; console.log("  ✓ " + n); };
const bad = (n: string, d: string) => { failc++; console.log("  ✗ " + n + " — " + d); };
const check = (n: string, cond: boolean, d = "") => (cond ? ok(n) : bad(n, d || "failed"));
async function expectStatus(n: string, status: number, fn: () => Promise<unknown>) {
  try {
    await fn();
    bad(n, `expected ${status}, but call succeeded`);
  } catch (e) {
    const s = (e as { statusCode?: number }).statusCode;
    check(n, s === status, `expected ${status}, got ${s ?? "(no statusCode)"} — ${(e as Error).message}`);
  }
}
/** Run a repo call as a specific authenticated user (sets the AsyncLocalStorage ctx). */
const as = <T>(userId: string, fn: () => Promise<T>): Promise<T> => userStore.run({ userId }, fn);

// ── fixed test scope ─────────────────────────────────────────────────────────
const A = "pgt_founderA";   // founder, owns App X / Z / W
const B = "pgt_testerB";    // tester, vertical = Construction
const C = "pgt_testerC";    // tester / attacker
const APP_X = "pgt_appX";   // Construction, ENROLLING (B will opt in)
const APP_Z = "pgt_appZ";   // Construction, ENROLLING
const APP_W = "pgt_appW";   // Fitness, ENROLLING
const USERS = [A, B, C];
const APPS = [APP_X, APP_Z, APP_W];

async function cleanup() {
  await prisma.broadcastReply.deleteMany({ where: { OR: [{ authorId: { in: USERS } }, { broadcast: { appId: { in: APPS } } }] } });
  await prisma.broadcast.deleteMany({ where: { appId: { in: APPS } } });
  await prisma.feedback.deleteMany({ where: { cycle: { testerId: { in: USERS } } } });
  await prisma.installProof.deleteMany({ where: { cycle: { testerId: { in: USERS } } } });
  await prisma.checkIn.deleteMany({ where: { cycle: { testerId: { in: USERS } } } });
  await prisma.dailyCheckIn.deleteMany({ where: { cycle: { testerId: { in: USERS } } } });
  await prisma.cycle.deleteMany({ where: { OR: [{ testerId: { in: USERS } }, { appId: { in: APPS } }] } });
  await prisma.enrollment.deleteMany({ where: { OR: [{ testerId: { in: USERS } }, { appId: { in: APPS } }] } });
  await prisma.notification.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.app.deleteMany({ where: { OR: [{ id: { in: APPS } }, { founderId: { in: USERS } }] } });
  await prisma.professionalProfile.deleteMany({ where: { userId: { in: USERS } } });
  await prisma.user.deleteMany({ where: { id: { in: USERS } } });
}

async function seed() {
  await prisma.user.create({ data: { id: A, email: "pgt.founderA@test.local", name: "Founder A", isFounder: true } });
  await prisma.user.create({
    data: {
      id: B, email: "pgt.testerB@test.local", name: "Tester B", isProfessional: true,
      professional: { create: { vertical: "Construction", categories: ["Construction"], publicSlug: "pgt-tester-b" } },
    },
  });
  await prisma.user.create({
    data: {
      id: C, email: "pgt.testerC@test.local", name: "Tester C", isProfessional: true,
      professional: { create: { vertical: "Fitness", categories: ["Fitness"], publicSlug: "pgt-tester-c" } },
    },
  });
  const app = (id: string, name: string, vertical: string, pkg: string) =>
    prisma.app.create({ data: { id, founderId: A, name, packageName: pkg, vertical, feedbackFocus: "core flow", status: "ENROLLING", minTesters: 16, startDate: new Date() } });
  await app(APP_X, "PG Test X", "Construction", "com.pgtest.x");
  await app(APP_Z, "PG Test Z", "Construction", "com.pgtest.z");
  await app(APP_W, "PG Test W", "Fitness", "com.pgtest.w");
}

async function run() {
  console.log("\n=== TrialCrew backend — Postgres integration (IDOR + two-sided connection) ===\n");

  await cleanup();
  await seed();

  console.log("[#2 connection: tester opt-in → founder-visible enrollment]");
  const cycle = await as(B, () => repo.optIn(APP_X));
  check("B opt-in → ACTIVE cycle", cycle.status === "ACTIVE" && !!cycle.id);

  let enrolls = await as(A, () => repo.getEnrollments(APP_X));
  const mine = enrolls.find((e) => e.gmail === cycle.gmailForCampaign);
  check("founder A sees exactly B in the cohort", enrolls.length === 1 && !!mine, `len=${enrolls.length}`);
  check("enrollment denormalizes tester name + status TESTING", mine?.testerName === "Tester B" && mine?.status === "TESTING");

  const emails = await as(A, () => repo.exportEmails(APP_X));
  check("exportEmails includes B's Gmail", emails.includes(cycle.gmailForCampaign), emails.join(","));

  await as(B, () => repo.dailyCheckIn(cycle.id));
  enrolls = await as(A, () => repo.getEnrollments(APP_X));
  check("daily check-in syncs to founder view (dailyDone=1)", enrolls[0]?.dailyDone === 1, `dailyDone=${enrolls[0]?.dailyDone}`);

  await as(B, () => repo.submitFeedback(cycle.id, { ease_of_use: 4, crashes: false }));
  const enr = await as(A, () => repo.getEnrollment(mine!.id));
  check("feedback marks enrollment COMPLETED + feedbackSubmitted", enr?.status === "COMPLETED" && enr?.feedbackSubmitted === true);

  console.log("\n[#2 matching: tester's vertical surfaces first]");
  const browse = await as(B, () => repo.getBrowseCampaigns());
  const iZ = browse.findIndex((c) => c.appName === "PG Test Z"); // Construction (matches B)
  const iW = browse.findIndex((c) => c.appName === "PG Test W"); // Fitness
  check("opted-in app X is excluded from browse", !browse.some((c) => c.appName === "PG Test X"));
  check("same-vertical app ranks before off-vertical", iZ >= 0 && iW >= 0 && iZ < iW, `iZ=${iZ} iW=${iW}`);

  console.log("\n[#1 IDOR: attacker C cannot touch B's / A's data]");
  const stolen = await as(C, () => repo.getCycle(cycle.id));
  check("C reading B's cycle → null", stolen === null);
  await expectStatus("C claiming B's reward → 404", 404, () => as(C, () => repo.claimReward(cycle.id)));
  await expectStatus("C daily-checkin on B's cycle → 404", 404, () => as(C, () => repo.dailyCheckIn(cycle.id)));
  await expectStatus("C submitting feedback on B's cycle → 404", 404, () => as(C, () => repo.submitFeedback(cycle.id, { x: 1 })));
  await expectStatus("C reading A's enrollments → 404", 404, () => as(C, () => repo.getEnrollments(APP_X)));
  await expectStatus("C exporting A's emails → 404", 404, () => as(C, () => repo.exportEmails(APP_X)));
  const stolenEnr = await as(C, () => repo.getEnrollment(mine!.id));
  check("C reading A's enrollment by id → null (scoped, no leak)", stolenEnr === null);
  await expectStatus("C broadcasting to an app it doesn't own → 403", 403, () => as(C, () => repo.sendBroadcast("com.pgtest.x", "spam")));

  console.log("\n[#1 anti-impersonation: reply identity comes from the caller]");
  const bc = await as(A, () => repo.sendBroadcast("com.pgtest.x", "new build is live"));
  await expectStatus("C (not in cohort) replying → 403", 403, () => as(C, () => repo.postReply(bc.id, "Founder A", "FOUNDER", "I am the founder")));
  const bReply = await as(B, () => repo.postReply(bc.id, "Hacker", "FOUNDER", "hi")); // claims FOUNDER…
  check("B's reply is forced to TESTER (client role ignored)", bReply.authorRole === "TESTER", `role=${bReply.authorRole}`);
  const aReply = await as(A, () => repo.postReply(bc.id, "x", "TESTER", "thanks"));
  check("A's reply is forced to FOUNDER / 'You'", aReply.authorRole === "FOUNDER" && aReply.authorName === "You");

  console.log("\n[#3 scheduler: cadence sweep marks missed + drops, on Postgres]");
  const { runSweepOnce } = await import("../src/scheduler/runner.js");
  // C opts into Z → a fresh ACTIVE cycle whose check-ins are scheduled days 3/7/10/14 out.
  const cCycle = await as(C, () => repo.optIn(APP_Z));
  const DAY = 24 * 60 * 60 * 1000;
  // Run the sweep ~20 days out (scoped to C so we never touch other cycles): every check-in is
  // now past its grace window → missed → C is dropped from both sides.
  const res = await runSweepOnce(new Date(Date.now() + 20 * DAY), { testerId: C });
  check("sweep dropped the missed cycle", res.cyclesDropped >= 1 && res.checkInsMissed >= 1, JSON.stringify(res));
  const droppedCycle = await prisma.cycle.findUnique({ where: { id: cCycle.id } });
  check("C's cycle → DROPPED", droppedCycle?.status === "DROPPED");
  const cEnr = await prisma.enrollment.findFirst({ where: { appId: APP_Z, testerId: C } });
  check("C's enrollment → DROPPED (both sides)", cEnr?.status === "DROPPED");
  const notifs = await prisma.notification.findMany({ where: { userId: C } });
  check("drop recorded an in-app notification", notifs.some((n) => n.title === "Removed from test"));
  // Idempotency: cycle is no longer ACTIVE → a second sweep does nothing.
  const res2 = await runSweepOnce(new Date(Date.now() + 20 * DAY), { testerId: C });
  check("re-running the sweep is a no-op", res2.cyclesScanned === 0 && res2.cyclesDropped === 0, JSON.stringify(res2));

  await cleanup();

  console.log(`\n${failc ? "✗ FAILED" : "✓ PASSED"} — ${pass} checks passed, ${failc} failed.`);
  await prisma.$disconnect();
  process.exit(failc ? 1 : 0);
}

run().catch(async (e) => {
  console.error("\n✗ test crashed:", e);
  try { await cleanup(); } catch { /* ignore */ }
  await prisma.$disconnect();
  process.exit(1);
});
