/**
 * PURE check-in cadence logic — no DB, no I/O, fully unit-testable.
 *
 * A cycle runs 14 days with formal check-ins on days 3/7/10/14. Each sweep (run on a
 * schedule by `../scheduler/index.ts`) turns the current cycle state + `now` into a PLAN
 * of what should change: which check-ins to remind, which to mark missed, whether to drop
 * the tester, and which push notifications to send. The runner applies the plan in a txn.
 *
 * Keeping this a pure function means the 14-day rules are verifiable without a Postgres
 * (see `scripts/sweep-test.ts`).
 */

export type CheckInStatus = "PENDING" | "SENT" | "RESPONDED" | "MISSED";
export type CycleStatus = "MATCHED" | "INVITED" | "INSTALLED" | "ACTIVE" | "COMPLETED" | "DROPPED";
export type NotificationKind = "MATCH" | "BROADCAST" | "REMINDER" | "REWARD" | "SYSTEM";

const DAY = 24 * 60 * 60 * 1000;
/** A tester has this long AFTER a scheduled check-in before it counts as missed. */
export const MISS_GRACE_MS = 2 * DAY;

export interface CheckInSnap {
  id: string;
  dayNumber: number;
  scheduledFor: Date;
  status: CheckInStatus;
}

export interface CycleSnap {
  id: string;
  status: CycleStatus;
  enrollmentId: string | null;
  testerId: string;
  pushToken: string | null;
  appName: string;
  checkIns: CheckInSnap[];
}

export interface PushMsg {
  userId: string;
  token: string | null;
  kind: NotificationKind;
  title: string;
  body: string;
}

export interface SweepPlan {
  cycleId: string;
  checkInsToSend: string[]; // PENDING + due  → mark SENT (and remind)
  checkInsToMiss: string[]; // overdue + unanswered → mark MISSED
  dropCycle: boolean; // a missed check-in drops the tester from the cohort
  pushes: PushMsg[];
}

const empty = (cycleId: string): SweepPlan => ({ cycleId, checkInsToSend: [], checkInsToMiss: [], dropCycle: false, pushes: [] });

/** Compute what should change for one cycle at time `now`. Idempotent: re-running yields no new work. */
export function planCycleSweep(c: CycleSnap, now: Date): SweepPlan {
  const plan = empty(c.id);
  // Only running cycles have a live cadence.
  if (c.status !== "ACTIVE") return plan;

  const t = now.getTime();
  const remind = (title: string, body: string, kind: NotificationKind = "REMINDER") =>
    plan.pushes.push({ userId: c.testerId, token: c.pushToken, kind, title, body });

  for (const ci of c.checkIns) {
    if (ci.status === "RESPONDED" || ci.status === "MISSED") continue;
    const scheduled = ci.scheduledFor.getTime();
    if (t >= scheduled + MISS_GRACE_MS) {
      plan.checkInsToMiss.push(ci.id); // overdue past grace, never answered
    } else if (t >= scheduled && ci.status === "PENDING") {
      plan.checkInsToSend.push(ci.id); // due now, not yet nudged
      remind(`Day ${ci.dayNumber} check-in`, `How's testing ${c.appName}? Tap to check in and keep your spot.`);
    }
  }

  // A missed check-in (new this sweep, or an unresolved one) drops the tester.
  const hasMissed = plan.checkInsToMiss.length > 0 || c.checkIns.some((ci) => ci.status === "MISSED");
  if (hasMissed) {
    plan.dropCycle = true;
    remind("Removed from test", `You missed a check-in for ${c.appName} and were removed from the cohort.`, "SYSTEM");
  }

  return plan;
}
