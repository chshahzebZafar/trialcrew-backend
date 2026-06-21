/**
 * Postgres data layer (Prisma) — implements the same `Repo` contract as the
 * in-memory store. Active when DATABASE_URL is set. Maps Prisma rows → API DTOs
 * (types.ts) so the HTTP contract is identical to the mock.
 *
 * Single-tenant demo: the "demo user" (seeded) is both tester and founder.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "./db.js";
import { currentAuthUser } from "./context.js";
import type { Repo } from "./repo.js";
import type {
  Broadcast,
  BroadcastReply,
  Campaign,
  CheckInDay,
  Cycle,
  Enrollment,
  Feedback,
  FeedbackQuestion,
  FounderApp,
  FounderStats,
  FounderTesterRow,
  AppNotification as NotificationDTO,
  TesterProfile,
} from "./types.js";

const DAY = 86400000;
const CYCLE_DAYS = 14;
const DEMO_EMAIL = "sam.rivera@example.com";

// Interactive-transaction limits. The default 5s timeout is too tight for our multi-step
// writes (opt-in does ~8 round-trips) once there's real network latency or DB contention.
const TX = { maxWait: 10_000, timeout: 20_000 } as const;
const iso = (d?: Date | null): string | undefined => (d ? d.toISOString() : undefined);
const err = (m: string, c: number) => Object.assign(new Error(m), { statusCode: c });

/**
 * The caller's User id. With Clerk enabled the auth hook puts it on the request
 * context; otherwise (demo mode) fall back to the seeded demo user.
 */
let demoId: string | null = null;
async function demoUserId(): Promise<string> {
  const ctx = currentAuthUser();
  if (ctx) return ctx.userId;
  if (!demoId) {
    const u = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
    if (!u) throw err("Demo user not seeded — run `npm run db:seed`", 500);
    demoId = u.id;
  }
  return demoId;
}

const feedbackQuestions: FeedbackQuestion[] = [
  { id: "first_impression", prompt: "What was your first impression on launch?", type: "text" },
  { id: "ease_of_use", prompt: "How easy was the app to use?", type: "rating" },
  { id: "crashes", prompt: "Did you hit any crashes or broken screens?", type: "boolean" },
  { id: "fit_for_vertical", prompt: "How well does it fit real field-services work?", type: "rating" },
  { id: "biggest_gap", prompt: "What is the single biggest gap or missing feature?", type: "text" },
  { id: "would_recommend", prompt: "Would you recommend it to a peer?", type: "boolean" },
];

// ── Mappers ───────────────────────────────────────────────────────────────────

type AppRow = Prisma.AppGetPayload<{ include: { _count: { select: { enrollments: true } } } }>;
const cycleInclude = { app: true, checkIns: { orderBy: { dayNumber: "asc" } }, dailyCheckIns: { orderBy: { day: "asc" } }, proof: true, feedback: true } satisfies Prisma.CycleInclude;
type CycleRow = Prisma.CycleGetPayload<{ include: typeof cycleInclude }>;

function toCampaign(app: { id: string; name: string; packageName: string; vertical: string; feedbackFocus: string; description: string | null; rewardType: string; playStoreUrl: string | null }, matched: number): Campaign {
  return {
    id: app.id, appName: app.name, packageName: app.packageName, vertical: app.vertical,
    feedbackFocus: app.feedbackFocus, description: app.description ?? undefined,
    testersNeeded: 12, testersMatched: matched, rewardType: app.rewardType as Campaign["rewardType"],
    playStoreUrl: app.playStoreUrl ?? undefined,
  };
}

function toFounderApp(a: AppRow): FounderApp {
  return {
    id: a.id, name: a.name, packageName: a.packageName, vertical: a.vertical,
    description: a.description ?? undefined, feedbackFocus: a.feedbackFocus,
    playStoreUrl: a.playStoreUrl ?? undefined, status: a.status, rewardType: a.rewardType,
    minTesters: a.minTesters, enrolledCount: a._count.enrollments, feedbackCount: a.feedbackCount,
    startDate: iso(a.startDate), publishedAt: iso(a.publishedAt), createdAt: a.createdAt.toISOString(),
  };
}

function toCycle(c: CycleRow): Cycle {
  return {
    id: c.id,
    campaign: toCampaign(c.app, 0),
    status: c.status,
    gmailForCampaign: c.gmailForCampaign,
    optInAt: iso(c.optInAt), completesAt: iso(c.completesAt), completedAt: iso(c.completedAt),
    founderRating: c.founderRating ?? undefined,
    rewardClaimed: c.rewardClaimed,
    checkIns: c.checkIns.map((ci) => ({ id: ci.id, dayNumber: ci.dayNumber as CheckInDay, scheduledFor: ci.scheduledFor.toISOString(), status: ci.status, response: ci.response ?? undefined, respondedAt: iso(ci.respondedAt) })),
    dailyCheckIns: c.dailyCheckIns.map((d) => ({ day: d.day, doneAt: iso(d.doneAt) })),
    proof: c.proof ? { id: c.proof.id, screenshotUrl: c.proof.screenshotUrl, verified: c.proof.verified, uploadedAt: c.proof.uploadedAt.toISOString() } : undefined,
    feedback: c.feedback ? { answers: c.feedback.answers as Feedback["answers"], submittedAt: c.feedback.submittedAt.toISOString() } : undefined,
  };
}

function toEnrollment(e: Prisma.EnrollmentGetPayload<{}>): Enrollment {
  return { id: e.id, appId: e.appId, testerName: e.testerName, gmail: e.gmail, badgeTier: e.badgeTier, reliabilityScore: e.reliabilityScore, enrolledAt: e.enrolledAt.toISOString(), dailyDone: e.dailyDone, status: e.status, feedbackSubmitted: e.feedbackSubmitted, rated: e.rated };
}

function cycleDay(optInAt: Date): number {
  return Math.min(CYCLE_DAYS, Math.max(1, Math.floor((Date.now() - optInAt.getTime()) / DAY) + 1));
}

// A Prisma client OR an interactive-transaction client — lets helpers run inside `$transaction`.
type Db = Prisma.TransactionClient;

// ── Ownership guards (prevent IDOR — a caller may only touch their own data) ──
async function ownCycleOrThrow(id: string, uid: string, db: Db = prisma): Promise<CycleRow> {
  const c = await db.cycle.findFirst({ where: { id, testerId: uid }, include: cycleInclude });
  if (!c) throw err("Cycle not found", 404);
  return c;
}
async function ownAppOrThrow(id: string, uid: string, db: Db = prisma) {
  const a = await db.app.findFirst({ where: { id, founderId: uid } });
  if (!a) throw err("App not found", 404);
  return a;
}
async function ownEnrollmentOrThrow(id: string, uid: string) {
  const e = await prisma.enrollment.findFirst({ where: { id, app: { founderId: uid } }, include: { app: true } });
  if (!e) throw err("Enrollment not found", 404);
  return e;
}


// ── Repo ──────────────────────────────────────────────────────────────────────

export const prismaRepo: Repo = {
  async getProfile(): Promise<TesterProfile> {
    const uid = await demoUserId();
    const user = await prisma.user.findUnique({ where: { id: uid }, include: { professional: true } });
    if (!user) throw err("User not found", 404);
    // New Clerk users have no profile yet — create a sensible default lazily.
    const p =
      user.professional ??
      (await prisma.professionalProfile.create({
        data: { userId: uid, vertical: "Construction", categories: [], verified: false, publicSlug: `tester-${uid.slice(0, 10)}` },
      }));
    return { id: user.id, name: user.name ?? "Tester", email: user.email, vertical: p.vertical, categories: p.categories, verified: p.verified, bio: p.bio ?? undefined, reliabilityScore: p.reliabilityScore, acceptedCycles: p.acceptedCycles, completedCycles: p.completedCycles, badgeTier: p.badgeTier, premiumUntil: iso(p.premiumUntil), credits: p.credits, stipendPending: p.stipendPending, publicSlug: p.publicSlug };
  },

  async getFeedbackQuestions() { return feedbackQuestions; },

  async setPushToken(token: string): Promise<{ ok: true }> {
    const uid = await demoUserId();
    await prisma.user.update({ where: { id: uid }, data: { pushToken: token } });
    return { ok: true };
  },

  async setRole(isFounder: boolean, isProfessional: boolean): Promise<{ ok: true }> {
    const uid = await demoUserId();
    await prisma.user.update({ where: { id: uid }, data: { isFounder, isProfessional } });
    // Ensure a tester profile exists once they take the professional role.
    if (isProfessional) {
      const existing = await prisma.professionalProfile.findUnique({ where: { userId: uid } });
      if (!existing) {
        await prisma.professionalProfile.create({
          data: { userId: uid, vertical: "Construction", categories: [], verified: false, publicSlug: `tester-${uid.slice(0, 10)}` },
        });
      }
    }
    return { ok: true };
  },

  async getNotifications(): Promise<NotificationDTO[]> {
    const uid = await demoUserId();
    const ns = await prisma.notification.findMany({ where: { userId: uid }, orderBy: { createdAt: "desc" } });
    return ns.map((n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, createdAt: n.createdAt.toISOString(), read: n.read }));
  },

  async markNotificationsRead(): Promise<NotificationDTO[]> {
    const uid = await demoUserId();
    await prisma.notification.updateMany({ where: { userId: uid }, data: { read: true } });
    return this.getNotifications();
  },

  async getBrowseCampaigns(): Promise<Campaign[]> {
    const uid = await demoUserId();
    const [myCycleApps, myProfile] = await Promise.all([
      prisma.cycle.findMany({ where: { testerId: uid }, select: { appId: true } }),
      prisma.professionalProfile.findUnique({ where: { userId: uid }, select: { vertical: true } }),
    ]);
    const exclude = new Set(myCycleApps.map((c) => c.appId));
    const myVertical = myProfile?.vertical;
    const apps = await prisma.app.findMany({ where: { status: "ENROLLING", founderId: { not: uid } }, include: { _count: { select: { enrollments: true } } } });
    return apps
      .filter((a) => !exclude.has(a.id))
      // Basic matching: surface apps in the tester's vertical first.
      .sort((a, b) => Number(b.vertical === myVertical) - Number(a.vertical === myVertical))
      .map((a) => toCampaign(a, a._count.enrollments));
  },

  async getCycles(): Promise<Cycle[]> {
    const uid = await demoUserId();
    const cs = await prisma.cycle.findMany({ where: { testerId: uid }, include: cycleInclude, orderBy: { optInAt: "desc" } });
    return cs.map(toCycle);
  },

  async getCycle(id: string): Promise<Cycle | null> {
    const uid = await demoUserId();
    const c = await prisma.cycle.findFirst({ where: { id, testerId: uid }, include: cycleInclude });
    return c ? toCycle(c) : null;
  },

  async optIn(campaignId: string): Promise<Cycle> {
    const uid = await demoUserId();
    // Reads first — validation + the tester profile we denormalize onto the enrollment. Kept
    // OUT of the transaction so the tx holds only writes (short, no timeout risk, small lock window).
    const app = await prisma.app.findUnique({ where: { id: campaignId } });
    if (!app) throw err("Campaign not found", 404);
    const [existing, u, existingEnr] = await Promise.all([
      prisma.cycle.findFirst({ where: { appId: campaignId, testerId: uid } }),
      prisma.user.findUnique({ where: { id: uid }, include: { professional: true } }),
      prisma.enrollment.findFirst({ where: { appId: campaignId, testerId: uid } }),
    ]);
    const t = Date.now();
    const data = {
      status: "ACTIVE" as const, optInAt: new Date(t), completesAt: new Date(t + CYCLE_DAYS * DAY),
      checkIns: { create: ([3, 7, 10, 14] as CheckInDay[]).map((d) => ({ dayNumber: d, scheduledFor: new Date(t + d * DAY), status: "PENDING" as const })) },
      dailyCheckIns: { create: Array.from({ length: CYCLE_DAYS }, (_, i) => ({ day: i + 1 })) },
    };
    // Atomic: the cycle, the accepted-count, and the founder-visible enrollment all land together.
    return prisma.$transaction(async (tx) => {
      const cycle = existing
        ? await tx.cycle.update({ where: { id: existing.id }, data, include: cycleInclude })
        : await tx.cycle.create({ data: { appId: campaignId, testerId: uid, gmailForCampaign: `sam.tc.${app.name.toLowerCase().replace(/\s+/g, "")}@gmail.com`, ...data }, include: cycleInclude });
      await tx.professionalProfile.update({ where: { userId: uid }, data: { acceptedCycles: { increment: 1 } } });
      // Make this tester visible in the founder's cohort (writes only — reads were done above).
      const enr = existingEnr
        ? await tx.enrollment.update({ where: { id: existingEnr.id }, data: { status: "TESTING", gmail: cycle.gmailForCampaign } })
        : await tx.enrollment.create({
            data: {
              appId: campaignId, testerId: uid, testerName: u?.name ?? "Tester", gmail: cycle.gmailForCampaign,
              badgeTier: u?.professional?.badgeTier ?? "NONE", reliabilityScore: u?.professional?.reliabilityScore ?? 0,
              status: "TESTING", dailyDone: 0,
            },
          });
      await tx.cycle.update({ where: { id: cycle.id }, data: { enrollmentId: enr.id } });
      return toCycle(cycle);
    }, TX);
  },

  async submitProof(cycleId: string, screenshotUrl: string): Promise<Cycle> {
    const uid = await demoUserId();
    await ownCycleOrThrow(cycleId, uid);
    await prisma.installProof.upsert({ where: { cycleId }, create: { cycleId, screenshotUrl }, update: { screenshotUrl, verified: false } });
    return toCycle(await ownCycleOrThrow(cycleId, uid));
  },

  async respondCheckIn(cycleId: string, day: CheckInDay, response: string): Promise<Cycle> {
    const uid = await demoUserId();
    const c = await ownCycleOrThrow(cycleId, uid);
    const ci = c.checkIns.find((x) => x.dayNumber === day);
    if (!ci) throw err("Check-in not found", 404);
    await prisma.checkIn.update({ where: { id: ci.id }, data: { status: "RESPONDED", response, respondedAt: new Date() } });
    return toCycle(await ownCycleOrThrow(cycleId, uid));
  },

  async dailyCheckIn(cycleId: string): Promise<Cycle> {
    const uid = await demoUserId();
    await prisma.$transaction(async (tx) => {
      const c = await ownCycleOrThrow(cycleId, uid, tx);
      if (c.optInAt) {
        const day = cycleDay(c.optInAt);
        const entry = c.dailyCheckIns.find((d) => d.day === day);
        if (entry && !entry.doneAt) await tx.dailyCheckIn.update({ where: { id: entry.id }, data: { doneAt: new Date() } });
      }
      // Keep the founder's cohort progress in sync with the tester's real check-ins.
      if (c.enrollmentId) {
        const dailyDone = await tx.dailyCheckIn.count({ where: { cycleId, doneAt: { not: null } } });
        await tx.enrollment.update({ where: { id: c.enrollmentId }, data: { dailyDone } });
      }
    }, TX);
    return toCycle(await ownCycleOrThrow(cycleId, uid));
  },

  async updateCycleEmail(cycleId: string, gmail: string): Promise<Cycle> {
    const uid = await demoUserId();
    const c = await ownCycleOrThrow(cycleId, uid);
    await prisma.$transaction(async (tx) => {
      await tx.cycle.update({ where: { id: cycleId }, data: { gmailForCampaign: gmail } });
      // Keep the founder-facing enrollment's Gmail in sync (Play Console export uses it).
      if (c.enrollmentId) await tx.enrollment.update({ where: { id: c.enrollmentId }, data: { gmail } });
    }, TX);
    return toCycle(await ownCycleOrThrow(cycleId, uid));
  },

  async submitFeedback(cycleId: string, answers: Feedback["answers"]): Promise<Cycle> {
    const uid = await demoUserId();
    await prisma.$transaction(async (tx) => {
      const c = await ownCycleOrThrow(cycleId, uid, tx);
      await tx.feedback.upsert({ where: { cycleId }, create: { cycleId, answers: answers as Prisma.InputJsonValue }, update: { answers: answers as Prisma.InputJsonValue, submittedAt: new Date() } });
      await tx.cycle.update({ where: { id: cycleId }, data: { status: "COMPLETED", completedAt: new Date() } });
      // Reflect completion in the founder's cohort view.
      if (c.enrollmentId) await tx.enrollment.update({ where: { id: c.enrollmentId }, data: { status: "COMPLETED", feedbackSubmitted: true } });
      const p = await tx.professionalProfile.findUnique({ where: { userId: uid } });
      if (p) {
        const completed = p.completedCycles + 1;
        const badge = completed >= 50 ? "EXPERT" : completed >= 20 ? "SENIOR" : completed >= 5 ? "VERIFIED" : "NONE";
        await tx.professionalProfile.update({ where: { userId: uid }, data: { completedCycles: completed, reliabilityScore: p.acceptedCycles > 0 ? completed / p.acceptedCycles : 0, badgeTier: badge } });
      }
    }, TX);
    return toCycle(await ownCycleOrThrow(cycleId, uid));
  },

  async claimReward(cycleId: string): Promise<Cycle> {
    const uid = await demoUserId();
    // Atomic: never grant the entitlement without also marking the cycle claimed (no double-claim).
    await prisma.$transaction(async (tx) => {
      const c = await ownCycleOrThrow(cycleId, uid, tx);
      if (c.status !== "COMPLETED") throw err("Cycle not complete", 400);
      if (c.rewardClaimed) return;
      await tx.cycle.update({ where: { id: cycleId }, data: { rewardClaimed: true } });
      const p = await tx.professionalProfile.findUnique({ where: { userId: uid } });
      if (p) {
        if (c.app.rewardType === "PREMIUM_ACCESS") {
          const base = p.premiumUntil ? Math.max(Date.now(), p.premiumUntil.getTime()) : Date.now();
          await tx.professionalProfile.update({ where: { userId: uid }, data: { premiumUntil: new Date(base + 90 * DAY) } });
        } else if (c.app.rewardType === "CREDITS") {
          await tx.professionalProfile.update({ where: { userId: uid }, data: { credits: { increment: 500 } } });
        } else {
          await tx.professionalProfile.update({ where: { userId: uid }, data: { stipendPending: { increment: 50 } } });
        }
      }
    }, TX);
    return toCycle(await ownCycleOrThrow(cycleId, uid));
  },

  // Founder
  async getFounderApps(): Promise<FounderApp[]> {
    const uid = await demoUserId();
    const apps = await prisma.app.findMany({ where: { founderId: uid }, include: { _count: { select: { enrollments: true } } }, orderBy: { createdAt: "desc" } });
    return apps.map(toFounderApp);
  },

  async getFounderApp(id: string): Promise<FounderApp | null> {
    const uid = await demoUserId();
    const a = await prisma.app.findFirst({ where: { id, founderId: uid }, include: { _count: { select: { enrollments: true } } } });
    return a ? toFounderApp(a) : null;
  },

  async getFounderTesters(): Promise<FounderTesterRow[]> {
    const uid = await demoUserId();
    const es = await prisma.enrollment.findMany({ where: { app: { founderId: uid } }, include: { app: true }, take: 12 });
    return es.map((e) => ({ id: e.id, testerName: e.testerName, appName: e.app.name, vertical: e.app.vertical, status: e.status === "ENROLLED" ? "MATCHED" : e.status === "TESTING" ? "ACTIVE" : (e.status as FounderTesterRow["status"]), dayProgress: e.dailyDone, reliabilityScore: e.reliabilityScore, badgeTier: e.badgeTier, rated: e.rated }));
  },

  async getFounderStats(): Promise<FounderStats> {
    const uid = await demoUserId();
    const apps = await prisma.app.findMany({ where: { founderId: uid }, include: { _count: { select: { enrollments: true } } } });
    const testersEngaged = apps.reduce((s, a) => s + a._count.enrollments, 0);
    const feedbackReceived = apps.reduce((s, a) => s + a.feedbackCount, 0);
    return { appsSubmitted: apps.length, activeCampaigns: apps.filter((a) => a.status === "ENROLLING" || a.status === "INVITED").length, testersEngaged, avgRating: 4.6, feedbackReceived };
  },

  async getEnrollments(appId: string): Promise<Enrollment[]> {
    const uid = await demoUserId();
    await ownAppOrThrow(appId, uid);
    const es = await prisma.enrollment.findMany({ where: { appId }, orderBy: { enrolledAt: "asc" } });
    return es.map(toEnrollment);
  },

  async getEnrollment(id: string): Promise<Enrollment | null> {
    const uid = await demoUserId();
    const e = await prisma.enrollment.findFirst({ where: { id, app: { founderId: uid } } });
    return e ? toEnrollment(e) : null;
  },

  async submitApp(input): Promise<FounderApp> {
    const uid = await demoUserId();
    const a = await prisma.app.create({ data: { founderId: uid, name: input.name, packageName: input.packageName, vertical: input.vertical, feedbackFocus: input.feedbackFocus, description: input.description, playStoreUrl: input.playStoreUrl, rewardType: input.rewardType, status: "DRAFT" }, include: { _count: { select: { enrollments: true } } } });
    return toFounderApp(a);
  },

  async publishApp(id, input): Promise<FounderApp> {
    const uid = await demoUserId();
    await ownAppOrThrow(id, uid);
    const a = await prisma.app.update({ where: { id }, data: { status: "ENROLLING", minTesters: input.minTesters, startDate: new Date(input.startDate), publishedAt: new Date() }, include: { _count: { select: { enrollments: true } } } });
    return toFounderApp(a);
  },

  async exportEmails(appId: string): Promise<string[]> {
    const uid = await demoUserId();
    await ownAppOrThrow(appId, uid);
    const es = await prisma.enrollment.findMany({ where: { appId, status: { not: "DROPPED" } }, select: { gmail: true } });
    return es.map((e) => e.gmail);
  },

  async markInvited(id: string): Promise<FounderApp> {
    const uid = await demoUserId();
    const cur = await ownAppOrThrow(id, uid);
    const a = await prisma.app.update({ where: { id }, data: { status: "INVITED", startDate: cur.startDate ?? new Date() }, include: { _count: { select: { enrollments: true } } } });
    return toFounderApp(a);
  },

  async rateTester(rowId: string): Promise<FounderTesterRow> {
    const uid = await demoUserId();
    await ownEnrollmentOrThrow(rowId, uid);
    const e = await prisma.enrollment.update({ where: { id: rowId }, data: { rated: true }, include: { app: true } });
    return { id: e.id, testerName: e.testerName, appName: e.app.name, vertical: e.app.vertical, status: e.status === "ENROLLED" ? "MATCHED" : e.status === "TESTING" ? "ACTIVE" : (e.status as FounderTesterRow["status"]), dayProgress: e.dailyDone, reliabilityScore: e.reliabilityScore, badgeTier: e.badgeTier, rated: e.rated };
  },

  async rateEnrollment(id: string): Promise<Enrollment> {
    const uid = await demoUserId();
    await ownEnrollmentOrThrow(id, uid);
    const e = await prisma.enrollment.update({ where: { id }, data: { rated: true } });
    return toEnrollment(e);
  },

  // Broadcasts
  async getBroadcasts(packageName: string): Promise<Broadcast[]> {
    const bs = await prisma.broadcast.findMany({ where: { packageName }, orderBy: { sentAt: "desc" } });
    return bs.map((b) => ({ id: b.id, packageName: b.packageName, message: b.message, sentAt: b.sentAt.toISOString() }));
  },

  async sendBroadcast(packageName: string, message: string): Promise<Broadcast> {
    const uid = await demoUserId();
    // Only the founder who OWNS an app on this package may broadcast to its cohort.
    const app = await prisma.app.findFirst({ where: { packageName, founderId: uid } });
    if (!app) throw err("You don't own an app for that package", 403);
    const b = await prisma.broadcast.create({ data: { appId: app.id, packageName, message } });
    return { id: b.id, packageName: b.packageName, message: b.message, sentAt: b.sentAt.toISOString() };
  },

  async getReplies(broadcastId: string): Promise<BroadcastReply[]> {
    const rs = await prisma.broadcastReply.findMany({ where: { broadcastId }, orderBy: { sentAt: "asc" } });
    return rs.map((r) => ({ id: r.id, broadcastId: r.broadcastId, authorName: r.authorName, authorRole: r.authorRole, message: r.message, sentAt: r.sentAt.toISOString() }));
  },

  // Author identity + role are DERIVED from the caller (not trusted from the client),
  // and only the app's founder or an enrolled tester may post.
  async postReply(broadcastId, _authorName, _authorRole, message): Promise<BroadcastReply> {
    const uid = await demoUserId();
    const bc = await prisma.broadcast.findUnique({ where: { id: broadcastId }, include: { app: true } });
    if (!bc) throw err("Broadcast not found", 404);
    const isFounder = bc.app.founderId === uid;
    if (!isFounder) {
      const hasCycle = await prisma.cycle.findFirst({ where: { appId: bc.appId, testerId: uid } });
      if (!hasCycle) throw err("Not part of this app's cohort", 403);
    }
    const user = await prisma.user.findUnique({ where: { id: uid } });
    const r = await prisma.broadcastReply.create({
      data: {
        broadcastId,
        authorId: uid,
        authorName: isFounder ? "You" : user?.name ?? "Tester",
        authorRole: isFounder ? "FOUNDER" : "TESTER",
        message,
      },
    });
    return { id: r.id, broadcastId: r.broadcastId, authorName: r.authorName, authorRole: r.authorRole, message: r.message, sentAt: r.sentAt.toISOString() };
  },
};
