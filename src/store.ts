/**
 * In-memory data store + operations — the current data layer. Mirrors the mobile
 * mock so the app gets identical behaviour over HTTP. Structured route → store so a
 * Prisma-backed implementation (see prisma/schema.prisma) can replace this file's
 * internals without touching the routes.
 *
 * Single-tenant demo: one person ("Sam Rivera") who is both tester and founder.
 */
import type {
  AppNotification,
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
  TesterProfile,
} from "./types.js";

const DAY = 86400000;
const CYCLE_DAYS = 14;
const now = () => Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const clone = <T>(v: T): T => structuredClone(v);

// ─── Seed data ────────────────────────────────────────────────────────────────

const feedbackQuestions: FeedbackQuestion[] = [
  { id: "first_impression", prompt: "What was your first impression on launch?", type: "text" },
  { id: "ease_of_use", prompt: "How easy was the app to use?", type: "rating" },
  { id: "crashes", prompt: "Did you hit any crashes or broken screens?", type: "boolean" },
  { id: "fit_for_vertical", prompt: "How well does it fit real field-services work?", type: "rating" },
  { id: "biggest_gap", prompt: "What is the single biggest gap or missing feature?", type: "text" },
  { id: "would_recommend", prompt: "Would you recommend it to a peer?", type: "boolean" },
];

let profile: TesterProfile = {
  id: "tester_self",
  name: "Sam Rivera",
  email: "sam.rivera@example.com",
  vertical: "Construction",
  categories: ["Site management", "Field services", "Estimating"],
  verified: true,
  bio: "15 yrs site management. I test field tools the way crews actually use them.",
  reliabilityScore: 0.86,
  acceptedCycles: 7,
  completedCycles: 6,
  badgeTier: "VERIFIED",
  credits: 0,
  stipendPending: 0,
  publicSlug: "sam-rivera",
};

const campaign = (
  id: string, appName: string, packageName: string, vertical: string,
  feedbackFocus: string, description: string, testersMatched: number,
  rewardType: Campaign["rewardType"], playStoreUrl?: string,
): Campaign => ({ id, appName, packageName, vertical, feedbackFocus, description, testersNeeded: 12, testersMatched, rewardType, playStoreUrl });

const browseCampaigns: Campaign[] = [
  campaign("camp_sitesync", "SiteSync", "com.sitesync.app", "Construction", "Daily logs & crew check-in flow", "Field logging app for construction crews. We want testers who run daily site logs.", 9, "PREMIUM_ACCESS", "https://play.google.com/store/apps/details?id=com.sitesync.app"),
  campaign("camp_punchlist", "PunchList Pro", "com.punchlistpro.app", "Construction", "Defect capture with photos", "Snag/punch-list tracking. Looking for QA-minded site managers.", 4, "PREMIUM_ACCESS"),
  campaign("camp_estimate", "QuickEstimate", "com.quickestimate.app", "Construction", "Estimate builder speed & accuracy", "On-site estimating tool. Estimators wanted.", 11, "CREDITS"),
  campaign("camp_fleettrack", "FleetTrack", "com.fleettrack.app", "Field services", "Live equipment & vehicle tracking", "GPS tracking for plant, vehicles and tools across multiple sites.", 6, "PREMIUM_ACCESS"),
  campaign("camp_safetyfirst", "SafetyFirst", "com.safetyfirst.app", "Construction", "Daily safety checklists & toolbox talks", "Digital site inductions, permits and toolbox talks.", 3, "STIPEND"),
  campaign("camp_probid", "ProBid", "com.probid.app", "Construction", "Tender & bid management flow", "Track tenders, compare subcontractor quotes and win more work.", 8, "CREDITS"),
  campaign("camp_crewclock", "CrewClock", "com.crewclock.app", "Field services", "Geofenced crew time tracking", "Clock crews in/out automatically with site geofences.", 10, "PREMIUM_ACCESS"),
  campaign("camp_materialflow", "MaterialFlow", "com.materialflow.app", "Construction", "Materials ordering & delivery tracking", "Request, approve and track material deliveries to site.", 5, "PREMIUM_ACCESS"),
];
const byCamp = (id: string) => browseCampaigns.find((c) => c.id === id)!;

const optedInCampaignIds = new Set<string>();
let cycles: Cycle[] = [];
let founderApps: FounderApp[] = [];
let enrollments: Enrollment[] = [];
let founderTesters: FounderTesterRow[] = [];
let founderStats: FounderStats = { appsSubmitted: 3, activeCampaigns: 2, testersEngaged: 17, avgRating: 4.6, feedbackReceived: 7 };
let broadcasts: Broadcast[] = [];
let replies: BroadcastReply[] = [];
let notifications: AppNotification[] = [];

// ─── Hydration (live, relative-to-now dates) ──────────────────────────────────

function dailyArray(optInMs: number, doneThrough: number, missed: number[] = []): Cycle["dailyCheckIns"] {
  const arr: NonNullable<Cycle["dailyCheckIns"]> = [];
  for (let d = 1; d <= CYCLE_DAYS; d++) {
    const done = d <= doneThrough && !missed.includes(d);
    arr.push({ day: d, doneAt: done ? iso(optInMs + d * DAY + 9 * 3600_000) : undefined });
  }
  return arr;
}

(function hydrate() {
  const t = now();

  // Active cycle — opted in 4 days ago, one missed day (at risk).
  const activeOptIn = t - 4 * DAY;
  cycles.push({
    id: "cycle_active",
    campaign: clone(byCamp("camp_sitesync")),
    status: "ACTIVE",
    gmailForCampaign: "sam.tc.sitesync@gmail.com",
    optInAt: iso(activeOptIn),
    completesAt: iso(activeOptIn + CYCLE_DAYS * DAY),
    checkIns: ([3, 7, 10, 14] as CheckInDay[]).map((d) => ({
      id: `ci_a${d}`, dayNumber: d, scheduledFor: iso(activeOptIn + d * DAY),
      status: d <= 3 ? "RESPONDED" : d <= 4 ? "SENT" : "PENDING",
      response: d <= 3 ? "Working well" : undefined,
    })),
    dailyCheckIns: dailyArray(activeOptIn, 4, [4]),
    proof: { id: "proof_a", screenshotUrl: "https://placehold.co/400x800", verified: true, uploadedAt: iso(activeOptIn) },
  });
  optedInCampaignIds.add("camp_sitesync");

  // Matched (not opted in)
  cycles.push({
    id: "cycle_matched",
    campaign: clone(byCamp("camp_punchlist")),
    status: "MATCHED",
    gmailForCampaign: "sam.tc.punchlist@gmail.com",
    checkIns: [],
  });

  // Completed
  const doneOptIn = t - 20 * DAY;
  cycles.push({
    id: "cycle_done",
    campaign: clone(byCamp("camp_estimate")),
    status: "COMPLETED",
    gmailForCampaign: "sam.tc.estimate@gmail.com",
    optInAt: iso(doneOptIn),
    completesAt: iso(doneOptIn + CYCLE_DAYS * DAY),
    completedAt: iso(doneOptIn + CYCLE_DAYS * DAY),
    founderRating: 5,
    checkIns: ([3, 7, 10, 14] as CheckInDay[]).map((d) => ({
      id: `ci_d${d}`, dayNumber: d, scheduledFor: iso(doneOptIn + d * DAY), status: "RESPONDED", response: "Good",
    })),
    dailyCheckIns: dailyArray(doneOptIn, 14),
    feedback: {
      answers: { first_impression: "Clean, fast", ease_of_use: 4, crashes: false, fit_for_vertical: 5, biggest_gap: "Offline mode", would_recommend: true },
      submittedAt: iso(doneOptIn + CYCLE_DAYS * DAY),
    },
  });
  optedInCampaignIds.add("camp_estimate");

  // Founder apps
  founderApps = [
    { id: "fapp_sitesync", name: "SiteSync", packageName: "com.sitesync.app", vertical: "Construction", feedbackFocus: "Daily logs & crew check-in flow", description: "Field logging app for construction crews.", playStoreUrl: "https://play.google.com/store/apps/details?id=com.sitesync.app", status: "INVITED", rewardType: "PREMIUM_ACCESS", minTesters: 16, enrolledCount: 16, feedbackCount: 7, startDate: iso(t - 6 * DAY), publishedAt: iso(t - 12 * DAY), createdAt: iso(t - 15 * DAY) },
    { id: "fapp_loadcalc", name: "LoadCalc Pro", packageName: "com.loadcalc.app", vertical: "Construction", feedbackFocus: "Structural load calculator accuracy", description: "Beam & load calculations for site engineers.", status: "ENROLLING", rewardType: "CREDITS", minTesters: 16, enrolledCount: 9, feedbackCount: 0, createdAt: iso(t - 6 * DAY) },
    { id: "fapp_sortsite", name: "SortSite", packageName: "com.sortsite.app", vertical: "Field services", feedbackFocus: "Waste sorting & disposal tracking", description: "Track skips, waste streams and disposal compliance.", status: "DRAFT", rewardType: "PREMIUM_ACCESS", minTesters: 16, enrolledCount: 0, feedbackCount: 0, createdAt: iso(t - 3 * DAY) },
  ];

  // Enrollments for SiteSync (running) — varied health for the analytics.
  const names = ["Sam Rivera", "Dana Brooks", "Marcus Hale", "Priya Nair", "Leo Fischer", "Aisha Khan", "Tom Reilly", "Mia Chen", "Omar Said", "Eva Novak", "Jack Doyle", "Lena Roth", "Carl West", "Nina Patel", "Hugo Berg", "Ivy Lane"];
  const tiers: Enrollment["badgeTier"][] = ["VERIFIED", "SENIOR", "EXPERT"];
  enrollments = names.map((n, i) => {
    const status: Enrollment["status"] = i === 2 ? "COMPLETED" : i === 15 ? "DROPPED" : "TESTING";
    const dailyDone = status === "COMPLETED" ? 14 : status === "DROPPED" ? 2 : Math.max(0, 5 - (i % 4));
    return { id: `enr_ss_${i}`, appId: "fapp_sitesync", testerName: n, gmail: `${n.toLowerCase().replace(/\s+/g, ".")}@gmail.com`, badgeTier: tiers[i % 3], reliabilityScore: 0.78 + (i % 5) * 0.04, enrolledAt: iso(t - (12 - (i % 8)) * DAY), dailyDone, status, feedbackSubmitted: status === "COMPLETED", rated: status === "COMPLETED" && i === 2 };
  });
  // LoadCalc enrollees (still enrolling)
  for (let i = 0; i < 9; i++) {
    enrollments.push({ id: `enr_lc_${i}`, appId: "fapp_loadcalc", testerName: names[i], gmail: `${names[i].toLowerCase().replace(/\s+/g, ".")}@gmail.com`, badgeTier: tiers[i % 3], reliabilityScore: 0.8 + (i % 4) * 0.03, enrolledAt: iso(t - (6 - (i % 5)) * DAY), dailyDone: 0, status: "ENROLLED", feedbackSubmitted: false, rated: false });
  }

  founderTesters = enrollments
    .filter((e) => e.appId === "fapp_sitesync" || e.appId === "fapp_loadcalc")
    .slice(0, 6)
    .map((e) => ({ id: `ft_${e.id}`, testerName: e.testerName, appName: e.appId === "fapp_sitesync" ? "SiteSync" : "LoadCalc Pro", vertical: "Construction", status: e.status === "ENROLLED" ? "MATCHED" : e.status === "TESTING" ? "ACTIVE" : (e.status as FounderTesterRow["status"]), dayProgress: e.dailyDone, reliabilityScore: e.reliabilityScore, badgeTier: e.badgeTier, rated: e.rated }));

  broadcasts = [
    { id: "bc_1", packageName: "com.sitesync.app", message: "New build pushed (v0.9.2) — fixes the crash on the daily-log save. Please update from Play before your next check-in.", sentAt: iso(t - 1 * DAY) },
    { id: "bc_2", packageName: "com.sitesync.app", message: "Thanks for the great feedback so far! Focus this week: try the crew check-in flow with 3+ people.", sentAt: iso(t - 4 * DAY) },
  ];
  replies = [
    { id: "br_1", broadcastId: "bc_1", authorName: "Dana Brooks", authorRole: "TESTER", message: "Updated — the save crash is gone for me. Daily logs feel snappy now.", sentAt: iso(t - 1 * DAY + 3600_000) },
    { id: "br_2", broadcastId: "bc_1", authorName: "You", authorRole: "FOUNDER", message: "Great, thanks Dana! Let me know if the offline case still hangs.", sentAt: iso(t - 1 * DAY + 7200_000) },
  ];
  notifications = [
    { id: "n_1", kind: "MATCH", title: "New match in your field", body: "PunchList Pro is looking for testers like you.", createdAt: iso(t - 600_000), read: false },
    { id: "n_2", kind: "BROADCAST", title: "SiteSync · team update", body: "New build pushed (v0.9.2) — please update before your next check-in.", createdAt: iso(t - 5 * 3600_000), read: false },
    { id: "n_3", kind: "REMINDER", title: "Daily check-in due", body: "Open SiteSync and confirm today's check-in to keep your streak.", createdAt: iso(t - 10 * 3600_000), read: false },
    { id: "n_4", kind: "REWARD", title: "Reward unlocked", body: "You completed QuickEstimate — claim your reward.", createdAt: iso(t - 15 * 3600_000), read: true },
    { id: "n_5", kind: "SYSTEM", title: "Welcome to TrialCrew", body: "Test real apps in your field and build a verified reputation.", createdAt: iso(t - 20 * 3600_000), read: true },
  ];
})();

function recomputeReliability() {
  profile.completedCycles += 1;
  profile.reliabilityScore = profile.acceptedCycles > 0 ? profile.completedCycles / profile.acceptedCycles : 0;
  profile.badgeTier = profile.completedCycles >= 50 ? "EXPERT" : profile.completedCycles >= 20 ? "SENIOR" : profile.completedCycles >= 5 ? "VERIFIED" : "NONE";
}

function mustCycle(id: string): Cycle {
  const c = cycles.find((x) => x.id === id);
  if (!c) throw Object.assign(new Error("Cycle not found"), { statusCode: 404 });
  return c;
}
function mustApp(id: string): FounderApp {
  const a = founderApps.find((x) => x.id === id);
  if (!a) throw Object.assign(new Error("App not found"), { statusCode: 404 });
  return a;
}

// ─── Public store API (the route handlers call these) ─────────────────────────

export const store = {
  // Tester
  getProfile: () => clone(profile),
  updateProfile: (input: { name?: string; vertical?: string; categories?: string[]; bio?: string }): TesterProfile => {
    if (input.name !== undefined) profile.name = input.name;
    if (input.vertical !== undefined) profile.vertical = input.vertical;
    if (input.categories !== undefined) profile.categories = input.categories;
    if (input.bio !== undefined) profile.bio = input.bio;
    return clone(profile);
  },
  getFeedbackQuestions: () => clone(feedbackQuestions),

  // Device + role (no-op in memory; real in Postgres)
  setPushToken: (_token: string): { ok: true } => ({ ok: true }),
  sendTestPush: (): { ok: true; sent: number; hasToken: boolean } => ({ ok: true, sent: 0, hasToken: false }),
  setRole: (_isFounder: boolean, _isProfessional: boolean): { ok: true } => ({ ok: true }),

  getNotifications: () => clone(notifications),
  markNotificationsRead: () => { notifications = notifications.map((n) => ({ ...n, read: true })); return clone(notifications); },
  getBrowseCampaigns: () => clone(browseCampaigns.filter((c) => !optedInCampaignIds.has(c.id))),
  getCycles: () => clone(cycles),
  getCycle: (id: string) => { const c = cycles.find((x) => x.id === id); return c ? clone(c) : null; },

  optIn(campaignId: string): Cycle {
    const t = now();
    let c = cycles.find((x) => x.campaign.id === campaignId);
    if (!c) {
      const camp = browseCampaigns.find((x) => x.id === campaignId);
      if (!camp) throw Object.assign(new Error("Campaign not found"), { statusCode: 404 });
      c = { id: `cycle_${campaignId}`, campaign: clone(camp), status: "MATCHED", gmailForCampaign: `sam.tc.${camp.appName.toLowerCase().replace(/\s+/g, "")}@gmail.com`, checkIns: [] };
      cycles.push(c);
    }
    c.optInAt = iso(t);
    c.completesAt = iso(t + CYCLE_DAYS * DAY);
    c.status = "ACTIVE";
    c.checkIns = ([3, 7, 10, 14] as CheckInDay[]).map((d) => ({ id: `${c!.id}_ci${d}`, dayNumber: d, scheduledFor: iso(t + d * DAY), status: "PENDING" }));
    c.dailyCheckIns = dailyArray(t, 0);
    optedInCampaignIds.add(campaignId);
    profile.acceptedCycles += 1;
    return clone(c);
  },

  submitProof(cycleId: string, screenshotUrl: string): Cycle {
    const c = mustCycle(cycleId);
    c.proof = { id: `proof_${cycleId}`, screenshotUrl, verified: false, uploadedAt: iso(now()) };
    return clone(c);
  },

  respondCheckIn(cycleId: string, day: CheckInDay, response: string): Cycle {
    const c = mustCycle(cycleId);
    const ci = c.checkIns.find((x) => x.dayNumber === day);
    if (!ci) throw Object.assign(new Error("Check-in not found"), { statusCode: 404 });
    ci.status = "RESPONDED";
    ci.response = response;
    ci.respondedAt = iso(now());
    return clone(c);
  },

  dailyCheckIn(cycleId: string): Cycle {
    const c = mustCycle(cycleId);
    if (!c.optInAt || !c.dailyCheckIns) return clone(c);
    const day = Math.min(CYCLE_DAYS, Math.max(1, Math.floor((now() - new Date(c.optInAt).getTime()) / DAY) + 1));
    const entry = c.dailyCheckIns.find((d) => d.day === day);
    if (entry && !entry.doneAt) entry.doneAt = iso(now());
    return clone(c);
  },

  updateCycleEmail(cycleId: string, gmail: string): Cycle {
    const c = mustCycle(cycleId);
    c.gmailForCampaign = gmail;
    return clone(c);
  },

  submitFeedback(cycleId: string, answers: Feedback["answers"]): Cycle {
    const c = mustCycle(cycleId);
    c.feedback = { answers, submittedAt: iso(now()) };
    c.status = "COMPLETED";
    c.completedAt = iso(now());
    recomputeReliability();
    return clone(c);
  },

  claimReward(cycleId: string): Cycle {
    const c = mustCycle(cycleId);
    if (c.status !== "COMPLETED") throw Object.assign(new Error("Cycle not complete"), { statusCode: 400 });
    if (c.rewardClaimed) return clone(c);
    c.rewardClaimed = true;
    if (c.campaign.rewardType === "PREMIUM_ACCESS") {
      const base = profile.premiumUntil ? Math.max(now(), new Date(profile.premiumUntil).getTime()) : now();
      profile.premiumUntil = iso(base + 90 * DAY);
    } else if (c.campaign.rewardType === "CREDITS") profile.credits += 500;
    else profile.stipendPending += 50;
    return clone(c);
  },

  // Founder
  getFounderApps: () => clone(founderApps),
  getFounderApp: (id: string) => { const a = founderApps.find((x) => x.id === id); return a ? clone(a) : null; },
  getFounderTesters: () => clone(founderTesters),
  getFounderStats: () => clone(founderStats),
  getEnrollments: (appId: string) => clone(enrollments.filter((e) => e.appId === appId)),
  seedTestEnrollments: (appId: string, _count?: number): Enrollment[] => clone(enrollments.filter((e) => e.appId === appId)),
  getEnrollment: (id: string) => { const e = enrollments.find((x) => x.id === id); return e ? clone(e) : null; },

  submitApp(input: { name: string; packageName: string; vertical: string; feedbackFocus: string; description?: string; playStoreUrl?: string; rewardType: FounderApp["rewardType"] }): FounderApp {
    const app: FounderApp = { id: `fapp_${input.name.toLowerCase().replace(/\s+/g, "")}_${founderApps.length}`, name: input.name, packageName: input.packageName, vertical: input.vertical, feedbackFocus: input.feedbackFocus, description: input.description, playStoreUrl: input.playStoreUrl, status: "DRAFT", rewardType: input.rewardType, minTesters: 16, enrolledCount: 0, feedbackCount: 0, createdAt: iso(now()) };
    founderApps = [app, ...founderApps];
    founderStats = { ...founderStats, appsSubmitted: founderStats.appsSubmitted + 1 };
    return clone(app);
  },

  updateApp(id: string, input: { name: string; packageName: string; vertical: string; feedbackFocus: string; description?: string; playStoreUrl?: string; rewardType: FounderApp["rewardType"] }): FounderApp {
    const a = mustApp(id);
    a.name = input.name; a.packageName = input.packageName; a.vertical = input.vertical;
    a.feedbackFocus = input.feedbackFocus; a.description = input.description;
    a.playStoreUrl = input.playStoreUrl; a.rewardType = input.rewardType;
    return clone(a);
  },

  publishApp(id: string, input: { minTesters: number; startDate: string }): FounderApp {
    const a = mustApp(id);
    a.status = "ENROLLING";
    a.minTesters = input.minTesters;
    a.startDate = input.startDate;
    a.publishedAt = iso(now());
    return clone(a);
  },

  exportEmails: (appId: string) => enrollments.filter((e) => e.appId === appId && e.status !== "DROPPED").map((e) => e.gmail),

  markInvited(id: string, testLink?: string): FounderApp {
    const a = mustApp(id);
    a.status = "INVITED";
    a.startDate = a.startDate ?? iso(now());
    if (testLink !== undefined) a.testLink = testLink;
    return clone(a);
  },

  endCohort(id: string): FounderApp {
    const a = mustApp(id);
    a.status = "COMPLETE";
    return clone(a);
  },

  rateTester(rowId: string): FounderTesterRow {
    const r = founderTesters.find((x) => x.id === rowId);
    if (!r) throw Object.assign(new Error("Tester not found"), { statusCode: 404 });
    r.rated = true;
    return clone(r);
  },

  rateEnrollment(id: string): Enrollment {
    const e = enrollments.find((x) => x.id === id);
    if (!e) throw Object.assign(new Error("Enrollment not found"), { statusCode: 404 });
    e.rated = true;
    return clone(e);
  },

  // Broadcasts
  getBroadcasts: (pkg: string) => clone(broadcasts.filter((b) => b.packageName === pkg).sort((a, b) => b.sentAt.localeCompare(a.sentAt))),
  sendBroadcast(pkg: string, message: string): Broadcast {
    const bc: Broadcast = { id: `bc_${broadcasts.length}_${pkg}`, packageName: pkg, message, sentAt: iso(now()) };
    broadcasts = [bc, ...broadcasts];
    return clone(bc);
  },
  getReplies: (broadcastId: string) => clone(replies.filter((r) => r.broadcastId === broadcastId).sort((a, b) => a.sentAt.localeCompare(b.sentAt))),
  postReply(broadcastId: string, authorName: string, authorRole: BroadcastReply["authorRole"], message: string): BroadcastReply {
    const r: BroadcastReply = { id: `br_${replies.length}_${broadcastId}`, broadcastId, authorName, authorRole, message, sentAt: iso(now()) };
    replies = [...replies, r];
    return clone(r);
  },
};
