/**
 * Seed the Postgres demo dataset — mirrors the in-memory store so the app behaves
 * identically on either driver. Idempotent: wipes + recreates.
 *
 *   npx prisma db seed   (or: npm run db:seed)
 */
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DAY = 86400000;
const now = Date.now();
const at = (deltaDays: number, extraMs = 0) => new Date(now + deltaDays * DAY + extraMs);

async function main() {
  // Wipe (child → parent order)
  await prisma.broadcastReply.deleteMany();
  await prisma.broadcast.deleteMany();
  await prisma.feedback.deleteMany();
  await prisma.installProof.deleteMany();
  await prisma.dailyCheckIn.deleteMany();
  await prisma.checkIn.deleteMany();
  await prisma.cycle.deleteMany();
  await prisma.enrollment.deleteMany();
  await prisma.notification.deleteMany();
  await prisma.app.deleteMany();
  await prisma.professionalProfile.deleteMany();
  await prisma.user.deleteMany();

  // ── Users ──
  const demo = await prisma.user.create({
    data: {
      email: "sam.rivera@example.com", name: "Sam Rivera", isFounder: true, isProfessional: true,
      professional: { create: {
        vertical: "Construction", categories: ["Site management", "Field services", "Estimating"],
        verified: true, bio: "15 yrs site management. I test field tools the way crews actually use them.",
        reliabilityScore: 0.86, acceptedCycles: 7, completedCycles: 6, badgeTier: "VERIFIED",
        credits: 0, stipendPending: 0, publicSlug: "sam-rivera",
      } },
    },
  });
  const other = await prisma.user.create({ data: { email: "founders@example.com", name: "Other Founders", isFounder: true } });

  // ── Browse apps (owned by `other`, ENROLLING so testers can browse) ──
  const browse = async (name: string, pkg: string, vertical: string, focus: string, desc: string, reward: "PREMIUM_ACCESS" | "CREDITS" | "STIPEND") =>
    prisma.app.create({ data: { founderId: other.id, name, packageName: pkg, vertical, feedbackFocus: focus, description: desc, rewardType: reward, status: "ENROLLING", minTesters: 12, publishedAt: at(-10) } });

  const siteSync = await browse("SiteSync", "com.sitesync.app", "Construction", "Daily logs & crew check-in flow", "Field logging app for construction crews.", "PREMIUM_ACCESS");
  const punchList = await browse("PunchList Pro", "com.punchlistpro.app", "Construction", "Defect capture with photos", "Snag/punch-list tracking.", "PREMIUM_ACCESS");
  const quickEstimate = await browse("QuickEstimate", "com.quickestimate.app", "Construction", "Estimate builder speed & accuracy", "On-site estimating tool.", "CREDITS");
  await browse("FleetTrack", "com.fleettrack.app", "Field services", "Live equipment & vehicle tracking", "GPS tracking for plant, vehicles and tools.", "PREMIUM_ACCESS");
  await browse("SafetyFirst", "com.safetyfirst.app", "Construction", "Daily safety checklists & toolbox talks", "Digital site inductions and permits.", "STIPEND");
  await browse("ProBid", "com.probid.app", "Construction", "Tender & bid management flow", "Track tenders and compare quotes.", "CREDITS");
  await browse("CrewClock", "com.crewclock.app", "Field services", "Geofenced crew time tracking", "Clock crews in/out with site geofences.", "PREMIUM_ACCESS");
  await browse("MaterialFlow", "com.materialflow.app", "Construction", "Materials ordering & delivery tracking", "Track material deliveries to site.", "PREMIUM_ACCESS");

  // ── Demo founder apps ──
  const fSiteSync = await prisma.app.create({ data: { founderId: demo.id, name: "SiteSync", packageName: "com.sitesync.app", vertical: "Construction", feedbackFocus: "Daily logs & crew check-in flow", description: "Field logging app for construction crews.", playStoreUrl: "https://play.google.com/store/apps/details?id=com.sitesync.app", status: "INVITED", rewardType: "PREMIUM_ACCESS", minTesters: 16, feedbackCount: 7, startDate: at(-6), publishedAt: at(-12) } });
  const fLoadCalc = await prisma.app.create({ data: { founderId: demo.id, name: "LoadCalc Pro", packageName: "com.loadcalc.app", vertical: "Construction", feedbackFocus: "Structural load calculator accuracy", description: "Beam & load calculations for site engineers.", status: "ENROLLING", rewardType: "CREDITS", minTesters: 16 } });
  await prisma.app.create({ data: { founderId: demo.id, name: "SortSite", packageName: "com.sortsite.app", vertical: "Field services", feedbackFocus: "Waste sorting & disposal tracking", description: "Track skips, waste streams and disposal compliance.", status: "DRAFT", rewardType: "PREMIUM_ACCESS", minTesters: 16 } });

  // ── Enrollments for demo founder apps ──
  const names = ["Sam Rivera", "Dana Brooks", "Marcus Hale", "Priya Nair", "Leo Fischer", "Aisha Khan", "Tom Reilly", "Mia Chen", "Omar Said", "Eva Novak", "Jack Doyle", "Lena Roth", "Carl West", "Nina Patel", "Hugo Berg", "Ivy Lane"];
  const tiers = ["VERIFIED", "SENIOR", "EXPERT"] as const;
  for (let i = 0; i < names.length; i++) {
    const status = i === 2 ? "COMPLETED" : i === 15 ? "DROPPED" : "TESTING";
    const dailyDone = status === "COMPLETED" ? 14 : status === "DROPPED" ? 2 : Math.max(0, 5 - (i % 4));
    await prisma.enrollment.create({ data: { appId: fSiteSync.id, testerName: names[i], gmail: `${names[i].toLowerCase().replace(/\s+/g, ".")}@gmail.com`, badgeTier: tiers[i % 3], reliabilityScore: 0.78 + (i % 5) * 0.04, dailyDone, status, feedbackSubmitted: status === "COMPLETED", rated: status === "COMPLETED" && i === 2, enrolledAt: at(-(12 - (i % 8))) } });
  }
  for (let i = 0; i < 9; i++) {
    await prisma.enrollment.create({ data: { appId: fLoadCalc.id, testerName: names[i], gmail: `${names[i].toLowerCase().replace(/\s+/g, ".")}.lc@gmail.com`, badgeTier: tiers[i % 3], reliabilityScore: 0.8 + (i % 4) * 0.03, dailyDone: 0, status: "ENROLLED", enrolledAt: at(-(6 - (i % 5))) } });
  }

  // ── Demo tester cycles (on browse apps) ──
  const ck = (d: number, scheduled: Date, status: "PENDING" | "SENT" | "RESPONDED", response?: string) => ({ dayNumber: d, scheduledFor: scheduled, status, response });

  // Active — opted in 4 days ago, day 4 missed
  await prisma.cycle.create({ data: {
    appId: siteSync.id, testerId: demo.id, gmailForCampaign: "sam.tc.sitesync@gmail.com", status: "ACTIVE",
    optInAt: at(-4), completesAt: at(10),
    checkIns: { create: [ck(3, at(-1), "RESPONDED", "Working well"), ck(7, at(3), "PENDING"), ck(10, at(6), "PENDING"), ck(14, at(10), "PENDING")] },
    dailyCheckIns: { create: Array.from({ length: 14 }, (_, i) => ({ day: i + 1, doneAt: i + 1 <= 3 ? at(-4, (i + 1) * DAY + 9 * 3600_000) : undefined })) },
    proof: { create: { screenshotUrl: "https://placehold.co/400x800", verified: true } },
  } });

  // Matched — not opted in
  await prisma.cycle.create({ data: { appId: punchList.id, testerId: demo.id, gmailForCampaign: "sam.tc.punchlist@gmail.com", status: "MATCHED" } });

  // Completed
  await prisma.cycle.create({ data: {
    appId: quickEstimate.id, testerId: demo.id, gmailForCampaign: "sam.tc.estimate@gmail.com", status: "COMPLETED",
    optInAt: at(-20), completesAt: at(-6), completedAt: at(-6), founderRating: 5,
    checkIns: { create: [3, 7, 10, 14].map((d) => ck(d, at(-20, d * DAY), "RESPONDED", "Good")) },
    dailyCheckIns: { create: Array.from({ length: 14 }, (_, i) => ({ day: i + 1, doneAt: at(-20, (i + 1) * DAY) })) },
    feedback: { create: { answers: { first_impression: "Clean, fast", ease_of_use: 4, crashes: false, fit_for_vertical: 5, biggest_gap: "Offline mode", would_recommend: true }, submittedAt: at(-6) } },
  } });

  // ── Broadcasts on com.sitesync.app (founder's app) + replies ──
  const b1 = await prisma.broadcast.create({ data: { appId: fSiteSync.id, packageName: "com.sitesync.app", message: "New build pushed (v0.9.2) — fixes the crash on the daily-log save. Please update from Play before your next check-in.", sentAt: at(-1) } });
  await prisma.broadcast.create({ data: { appId: fSiteSync.id, packageName: "com.sitesync.app", message: "Thanks for the great feedback so far! Focus this week: try the crew check-in flow with 3+ people.", sentAt: at(-4) } });
  await prisma.broadcastReply.create({ data: { broadcastId: b1.id, authorName: "Dana Brooks", authorRole: "TESTER", message: "Updated — the save crash is gone for me. Daily logs feel snappy now.", sentAt: at(-1, 3600_000) } });
  await prisma.broadcastReply.create({ data: { broadcastId: b1.id, authorId: demo.id, authorName: "You", authorRole: "FOUNDER", message: "Great, thanks Dana! Let me know if the offline case still hangs.", sentAt: at(-1, 7200_000) } });

  // ── Notifications ──
  const notifs = [
    { kind: "MATCH" as const, title: "New match in your field", body: "PunchList Pro is looking for testers like you.", read: false },
    { kind: "BROADCAST" as const, title: "SiteSync · team update", body: "New build pushed (v0.9.2) — please update before your next check-in.", read: false },
    { kind: "REMINDER" as const, title: "Daily check-in due", body: "Open SiteSync and confirm today's check-in to keep your streak.", read: false },
    { kind: "REWARD" as const, title: "Reward unlocked", body: "You completed QuickEstimate — claim your reward.", read: true },
    { kind: "SYSTEM" as const, title: "Welcome to TrialCrew", body: "Test real apps in your field and build a verified reputation.", read: true },
  ];
  for (let i = 0; i < notifs.length; i++) {
    await prisma.notification.create({ data: { userId: demo.id, ...notifs[i], createdAt: new Date(now - i * 5 * 3600_000 - 600_000) } });
  }

  console.log("✅ Seeded demo data (1 demo user, 11 apps, 25 enrollments, 3 cycles, 2 broadcasts).");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
