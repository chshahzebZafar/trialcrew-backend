/**
 * Unit test for the PURE 14-day cadence planner (`src/scheduler/sweep.ts`). No DB, no I/O —
 * runs anywhere. Proves the rules the Postgres sweep relies on: remind when due, miss after
 * grace, drop on a miss, never double-act, ignore non-active / answered check-ins.
 *
 *   npx tsx scripts/sweep-test.ts
 */
import { planCycleSweep, MISS_GRACE_MS, type CycleSnap, type CheckInStatus, type CycleStatus } from "../src/scheduler/sweep.js";

const DAY = 24 * 60 * 60 * 1000;
const opt = new Date("2026-01-01T00:00:00Z");
const at = (days: number, extraMs = 0) => new Date(opt.getTime() + days * DAY + extraMs);

let pass = 0, failc = 0;
const ok = (n: string) => { pass++; console.log("  ✓ " + n); };
const bad = (n: string, d: string) => { failc++; console.log("  ✗ " + n + " — " + d); };
const check = (n: string, cond: boolean, d = "") => (cond ? ok(n) : bad(n, d || "failed"));

const ci = (day: number, status: CheckInStatus) => ({ id: `ci${day}`, dayNumber: day, scheduledFor: at(day), status });
const cycle = (over: Partial<CycleSnap> = {}): CycleSnap => ({
  id: "cyc", status: "ACTIVE", enrollmentId: "enr", testerId: "u1",
  pushToken: "ExponentPushToken[x]", appName: "FleetTrack",
  checkIns: [ci(3, "PENDING"), ci(7, "PENDING"), ci(10, "PENDING"), ci(14, "PENDING")],
  ...over,
});

console.log("\n=== scheduler: pure cadence planner ===\n");

// A — early in the cycle: nothing due yet.
let p = planCycleSweep(cycle(), at(1));
check("day 1 → no reminders, no misses, no drop", p.checkInsToSend.length === 0 && p.checkInsToMiss.length === 0 && !p.dropCycle);
check("day 1 → no pushes", p.pushes.length === 0);

// B — day 3 reaches the first check-in → remind exactly that one.
p = planCycleSweep(cycle(), at(3));
check("day 3 → send only the day-3 check-in", p.checkInsToSend.join(",") === "ci3");
check("day 3 → one REMINDER push titled 'Day 3 check-in'", p.pushes.length === 1 && p.pushes[0].kind === "REMINDER" && p.pushes[0].title.includes("Day 3"));
check("day 3 → no miss / no drop", p.checkInsToMiss.length === 0 && !p.dropCycle);

// C — day-3 unanswered past the grace window → missed → tester dropped.
p = planCycleSweep(cycle(), at(3, MISS_GRACE_MS + 60_000));
check("past grace → day-3 marked missed", p.checkInsToMiss.join(",") === "ci3");
check("a miss drops the cycle", p.dropCycle === true);
check("drop emits a SYSTEM push", p.pushes.some((x) => x.kind === "SYSTEM" && x.title === "Removed from test"));
check("later check-ins (day 7+) untouched while not due", !p.checkInsToSend.includes("ci7"));

// D — non-active cycles have no live cadence.
p = planCycleSweep(cycle({ status: "COMPLETED" as CycleStatus }), at(99));
check("COMPLETED cycle → empty plan", p.checkInsToSend.length === 0 && p.checkInsToMiss.length === 0 && !p.dropCycle);

// E — an answered check-in is never re-touched.
p = planCycleSweep(cycle({ checkIns: [ci(3, "RESPONDED"), ci(7, "PENDING"), ci(10, "PENDING"), ci(14, "PENDING")] }), at(4));
check("RESPONDED day-3 ignored on day 4", p.checkInsToSend.length === 0 && p.checkInsToMiss.length === 0 && !p.dropCycle);

// F — already reminded (SENT) but then overdue → still missed.
p = planCycleSweep(cycle({ checkIns: [ci(3, "SENT"), ci(7, "PENDING"), ci(10, "PENDING"), ci(14, "PENDING")] }), at(3, MISS_GRACE_MS + 60_000));
check("SENT + overdue → missed + drop", p.checkInsToMiss.join(",") === "ci3" && p.dropCycle);

// G — idempotency: SENT and still within grace → no repeat work.
p = planCycleSweep(cycle({ checkIns: [ci(3, "SENT"), ci(7, "PENDING"), ci(10, "PENDING"), ci(14, "PENDING")] }), at(3, DAY / 2));
check("SENT within grace → no duplicate reminder, no miss", p.checkInsToSend.length === 0 && p.checkInsToMiss.length === 0 && !p.dropCycle);

// H — token-less tester still gets a notification row queued (delivery just skips it).
p = planCycleSweep(cycle({ pushToken: null }), at(3));
check("no push token → reminder still planned (token=null)", p.pushes.length === 1 && p.pushes[0].token === null);

console.log(`\n${failc ? "✗ FAILED" : "✓ PASSED"} — ${pass} checks passed, ${failc} failed.`);
process.exit(failc ? 1 : 0);
