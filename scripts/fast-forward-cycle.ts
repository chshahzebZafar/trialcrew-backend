/**
 * TESTING AID — backdate a cycle so all its check-ins are immediately "due", letting you
 * complete the 14-day flow in the app in minutes instead of waiting two weeks.
 *
 *   DATABASE_URL="postgres://…" npx tsx scripts/fast-forward-cycle.ts [cycleId]
 *
 * With no cycleId it fast-forwards the most recently started ACTIVE cycle. After running it,
 * open that cycle in the app and you can respond to every check-in, submit proof + feedback,
 * complete it, and claim the reward — then the founder side shows it completed.
 */
import { prisma } from "../src/db.js";

const DAY = 86400000;
const id = process.argv[2];

const cycle = id
  ? await prisma.cycle.findUnique({ where: { id }, include: { checkIns: true } })
  : await prisma.cycle.findFirst({ where: { status: "ACTIVE" }, orderBy: { optInAt: "desc" }, include: { checkIns: true } });

if (!cycle) {
  console.error("No matching ACTIVE cycle found.");
  process.exit(1);
}

const newOptIn = new Date(Date.now() - 15 * DAY); // day 15 → every check-in (3/7/10/14) is past
await prisma.cycle.update({
  where: { id: cycle.id },
  data: { optInAt: newOptIn, completesAt: new Date(Date.now() - DAY) },
});

// Move each check-in's scheduled date into the past so the app shows it as actionable.
for (const ci of cycle.checkIns) {
  await prisma.checkIn.update({
    where: { id: ci.id },
    data: { scheduledFor: new Date(newOptIn.getTime() + ci.dayNumber * DAY) },
  });
}

// Mark the daily proof-of-use as fully done (so it doesn't read as "missed every day").
await prisma.dailyCheckIn.updateMany({ where: { cycleId: cycle.id }, data: { doneAt: new Date() } });
if (cycle.enrollmentId) {
  await prisma.enrollment.update({ where: { id: cycle.enrollmentId }, data: { dailyDone: 14 } });
}

console.log(`✓ Fast-forwarded cycle ${cycle.id} (app ${cycle.appId}) — all check-ins are now due. Complete it in the app.`);
await prisma.$disconnect();
