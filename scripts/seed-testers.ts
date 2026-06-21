/**
 * TESTING AID — seed fake tester enrollments into an app so the founder reaches the
 * min-tester target and can test "Mark invited & start", export, cohort health, etc.
 *
 *   DATABASE_URL="postgres://…" npx tsx scripts/seed-testers.ts [appId] [count]
 *
 * With no appId it targets the most recently published ENROLLING app. With no count it
 * seeds exactly enough to reach the app's minTesters. These are denormalized rows (no real
 * user/cycle) — perfect for exercising the founder side without real testers.
 */
import { prisma } from "../src/db.js";

const appId = process.argv[2];
const explicitCount = process.argv[3] ? Number(process.argv[3]) : undefined;

const app = appId
  ? await prisma.app.findUnique({ where: { id: appId }, include: { _count: { select: { enrollments: true } } } })
  : await prisma.app.findFirst({ where: { status: "ENROLLING" }, orderBy: { publishedAt: "desc" }, include: { _count: { select: { enrollments: true } } } });

if (!app) {
  console.error("No ENROLLING app found — publish an app first, or pass an appId.");
  process.exit(1);
}

const need = explicitCount ?? Math.max(0, app.minTesters - app._count.enrollments);
if (need <= 0) {
  console.log(`"${app.name}" already has ${app._count.enrollments}/${app.minTesters} testers — nothing to add.`);
  process.exit(0);
}

const NAMES = ["Alex Carter", "Priya Nair", "Diego Santos", "Mei Lin", "Tom Webb", "Sara Khan", "Liam O'Brien", "Nina Petrov", "Omar Aziz", "Grace Park", "Jack Reed", "Yuki Tanaka", "Fatima Noor", "Ben Cohen", "Ivy Zhang"];
const TIERS = ["VERIFIED", "SENIOR", "EXPERT", "VERIFIED"] as const;

for (let i = 0; i < need; i++) {
  const name = NAMES[i % NAMES.length];
  await prisma.enrollment.create({
    data: {
      appId: app.id,
      testerName: name,
      gmail: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}.${i}@gmail.com`,
      badgeTier: TIERS[i % TIERS.length],
      reliabilityScore: 0.7 + (i % 3) * 0.1,
      status: "TESTING",
      dailyDone: 4 + (i % 8),
    },
  });
}

console.log(`✓ Seeded ${need} fake testers into "${app.name}" → now ${app._count.enrollments + need}/${app.minTesters}. The "Mark invited & start" button should now appear.`);
await prisma.$disconnect();
