/**
 * Sweep runner — the I/O around the pure planner. Pulls ACTIVE cycles, plans each, applies
 * the plan atomically (check-in status, drop cycle + enrollment together, persist in-app
 * notifications), then delivers the Expo pushes. Exported standalone so it can be driven by
 * pg-boss (`./index.ts`) OR an external cron hitting an endpoint — and so it's testable.
 */
import { prisma } from "../db.js";
import { planCycleSweep, type CycleSnap, type SweepPlan, type PushMsg } from "./sweep.js";
import { deliverPushes } from "./push.js";

export interface SweepResult {
  cyclesScanned: number;
  remindersSent: number;
  checkInsMissed: number;
  cyclesDropped: number;
  pushesDelivered: number;
}

/**
 * @param now    the clock to evaluate against (injectable for tests).
 * @param scope  optional narrowing — e.g. `{ testerId }` to sweep one tester (used by tests
 *               so they don't touch unrelated cycles). Production passes nothing → all active.
 */
export async function runSweepOnce(now: Date = new Date(), scope?: { testerId?: string }): Promise<SweepResult> {
  const cycles = await prisma.cycle.findMany({
    where: { status: "ACTIVE", ...(scope?.testerId ? { testerId: scope.testerId } : {}) },
    include: { checkIns: true, tester: { select: { id: true, pushToken: true } }, app: { select: { name: true } } },
  });

  const result: SweepResult = { cyclesScanned: cycles.length, remindersSent: 0, checkInsMissed: 0, cyclesDropped: 0, pushesDelivered: 0 };
  const pushes: PushMsg[] = [];

  for (const c of cycles) {
    const snap: CycleSnap = {
      id: c.id,
      status: c.status,
      enrollmentId: c.enrollmentId,
      testerId: c.testerId,
      pushToken: c.tester.pushToken,
      appName: c.app.name,
      checkIns: c.checkIns.map((ci) => ({ id: ci.id, dayNumber: ci.dayNumber, scheduledFor: ci.scheduledFor, status: ci.status })),
    };
    const plan = planCycleSweep(snap, now);
    if (!plan.checkInsToSend.length && !plan.checkInsToMiss.length && !plan.dropCycle) continue;

    await applyPlan(plan);
    result.remindersSent += plan.checkInsToSend.length;
    result.checkInsMissed += plan.checkInsToMiss.length;
    if (plan.dropCycle) result.cyclesDropped += 1;
    pushes.push(...plan.pushes);
  }

  result.pushesDelivered = await deliverPushes(pushes);
  return result;
}

async function applyPlan(plan: SweepPlan): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (plan.checkInsToSend.length) {
      await tx.checkIn.updateMany({ where: { id: { in: plan.checkInsToSend } }, data: { status: "SENT" } });
    }
    if (plan.checkInsToMiss.length) {
      await tx.checkIn.updateMany({ where: { id: { in: plan.checkInsToMiss } }, data: { status: "MISSED" } });
    }
    if (plan.dropCycle) {
      // Drop the tester from both sides at once.
      await tx.cycle.update({ where: { id: plan.cycleId }, data: { status: "DROPPED" } });
      await tx.enrollment.updateMany({ where: { cycle: { id: plan.cycleId } }, data: { status: "DROPPED" } });
    }
    if (plan.pushes.length) {
      await tx.notification.createMany({ data: plan.pushes.map((p) => ({ userId: p.userId, kind: p.kind, title: p.title, body: p.body })) });
    }
  });
}
