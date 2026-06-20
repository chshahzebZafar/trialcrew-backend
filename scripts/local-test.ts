/**
 * Local end-to-end test of the backend (in-memory driver). Uses Fastify's in-process
 * `inject()` — no ports, no DB, no flakiness. Walks every flow the app drives.
 *
 *   npx tsx scripts/local-test.ts
 */
import { buildServer } from "../src/server.js";

const app = buildServer();
let pass = 0, failc = 0;
const ok = (n: string) => { pass++; console.log("  ✓ " + n); };
const bad = (n: string, d: string) => { failc++; console.log("  ✗ " + n + " — " + d); };
const assert = (n: string, cond: boolean, d = "") => (cond ? ok(n) : bad(n, d || "failed"));

type R = { status: number; body: any };
async function req(method: string, url: string, payload?: unknown): Promise<R> {
  const res = await app.inject({ method: method as "GET", url, payload: payload as object });
  let body: unknown;
  try { body = res.json(); } catch { body = res.payload; }
  return { status: res.statusCode, body };
}

await app.ready();
console.log("\n=== TrialCrew backend — local end-to-end (in-memory) ===\n");
let r: R;

console.log("[health + tester]");
r = await req("GET", "/health");
assert("health ok (driver=memory, auth=demo)", r.status === 200 && r.body.driver === "memory" && r.body.auth === "demo", JSON.stringify(r.body));
r = await req("GET", "/me/profile");
assert("getProfile → Sam Rivera / VERIFIED", r.body.name === "Sam Rivera" && r.body.badgeTier === "VERIFIED");
r = await req("GET", "/me/cycles");
assert("getCycles → 3 seeded", r.body.length === 3, "len=" + r.body.length);
r = await req("GET", "/campaigns/matched");
assert("browse includes FleetTrack", (r.body as any[]).some((c) => c.appName === "FleetTrack"));

console.log("\n[tester cycle flow]");
r = await req("POST", "/campaigns/camp_fleettrack/opt-in");
const cid = r.body.id;
assert("optIn → ACTIVE + 14d clock + 14 dailies", r.body.status === "ACTIVE" && !!r.body.completesAt && r.body.dailyCheckIns.length === 14);
r = await req("POST", `/cycles/${cid}/daily-checkin`);
assert("dailyCheckIn marks today (1/14)", r.body.dailyCheckIns.filter((d: any) => d.doneAt).length === 1);
r = await req("POST", `/cycles/${cid}/checkins/3`, { response: "Going well" });
assert("respondCheckIn day3 → RESPONDED", r.body.checkIns.find((c: any) => c.dayNumber === 3).status === "RESPONDED");
r = await req("POST", `/cycles/${cid}/proof`, { screenshotUrl: "https://x/proof.png" });
assert("submitProof records proof", !!r.body.proof && r.body.proof.screenshotUrl.includes("proof.png"));
r = await req("PATCH", `/cycles/${cid}/email`, { gmail: "new.tester@gmail.com" });
assert("updateCycleEmail (Gmail)", r.body.gmailForCampaign === "new.tester@gmail.com");
r = await req("POST", `/cycles/${cid}/feedback`, { answers: { ease_of_use: 4, crashes: false, biggest_gap: "offline" } });
assert("submitFeedback → COMPLETED", r.body.status === "COMPLETED" && !!r.body.feedback);

console.log("\n[reward escrow + fulfillment]");
r = await req("POST", "/cycles/cycle_done/claim-reward");
assert("claimReward → claimed", r.body.rewardClaimed === true);
r = await req("GET", "/me/profile");
assert("entitlement granted (QuickEstimate=CREDITS → +500)", r.body.credits === 500, "credits=" + r.body.credits);

console.log("\n[notifications]");
r = await req("GET", "/me/notifications");
const unread = (r.body as any[]).filter((n) => !n.read).length;
assert("5 notifications, 3 unread", r.body.length === 5 && unread === 3, `len=${r.body.length} unread=${unread}`);
r = await req("POST", "/me/notifications/read");
assert("markRead → 0 unread", (r.body as any[]).filter((n) => !n.read).length === 0);

console.log("\n[founder flow]");
r = await req("GET", "/me/apps");
assert("getFounderApps ≥ 3", r.body.length >= 3, "len=" + r.body.length);
r = await req("POST", "/apps", { name: "TestApp", packageName: "com.test.app", vertical: "Construction", feedbackFocus: "core flow", rewardType: "CREDITS" });
const newApp = r.body;
assert("submitApp → DRAFT", newApp.status === "DRAFT" && newApp.name === "TestApp");
r = await req("POST", `/apps/${newApp.id}/publish`, { minTesters: 16, startDate: new Date().toISOString() });
assert("publishApp → ENROLLING (16)", r.body.status === "ENROLLING" && r.body.minTesters === 16);
r = await req("GET", "/apps/fapp_sitesync/enrollments");
assert("enrollments(SiteSync) = 16", r.body.length === 16, "len=" + r.body.length);
r = await req("GET", "/apps/fapp_sitesync/emails");
assert("exportEmails excludes dropped → 15", r.body.length === 15, "len=" + r.body.length);
r = await req("POST", "/apps/fapp_loadcalc/invited");
assert("markInvited → INVITED", r.body.status === "INVITED");
r = await req("GET", "/me/founder-stats");
assert("founderStats present", typeof r.body.appsSubmitted === "number" && typeof r.body.testersEngaged === "number");
r = await req("GET", "/me/testers");
assert("founderTesters list", Array.isArray(r.body) && r.body.length > 0);

console.log("\n[broadcasts + two-way thread]");
r = await req("GET", "/broadcasts?packageName=com.sitesync.app");
assert("getBroadcasts = 2", r.body.length === 2, "len=" + r.body.length);
r = await req("POST", "/broadcasts", { packageName: "com.sitesync.app", message: "new build pushed" });
assert("sendBroadcast", r.body.message === "new build pushed");
r = await req("GET", "/broadcasts/bc_1/replies");
const rep0 = r.body.length;
r = await req("POST", "/broadcasts/bc_1/replies", { authorName: "Sam", authorRole: "TESTER", message: "works for me" });
assert("postReply", r.body.message === "works for me" && r.body.authorRole === "TESTER");
r = await req("GET", "/broadcasts/bc_1/replies");
assert("thread grew by 1", r.body.length === rep0 + 1);

console.log("\n[account + storage]");
r = await req("POST", "/me/push-token", { token: "ExponentPushToken[abc]" });
assert("setPushToken → ok", r.body.ok === true);
r = await req("POST", "/me/role", { isFounder: true, isProfessional: true });
assert("setRole → ok", r.body.ok === true);
r = await req("POST", "/cycles/cycle_active/proof/upload-url", { contentType: "image/png" });
assert("proof upload-url inert (R2 off) + key", r.body.configured === false && String(r.body.key).startsWith("proofs/"));

console.log("\n[validation + errors]");
r = await req("POST", "/apps/fapp_sortsite/publish", { minTesters: 3, startDate: "2026-07-01" });
assert("publish minTesters<12 → 400", r.status === 400, "status=" + r.status);
r = await req("GET", "/cycles/does-not-exist");
assert("unknown cycle → 404", r.status === 404, "status=" + r.status);
r = await req("POST", "/me/push-token", {});
assert("push-token missing token → 400", r.status === 400, "status=" + r.status);
r = await req("PATCH", "/cycles/" + cid + "/email", { gmail: "not-an-email" });
assert("bad email → 400", r.status === 400, "status=" + r.status);

await app.close();
console.log(`\n${failc ? "✗ FAILED" : "✓ PASSED"} — ${pass} checks passed, ${failc} failed.`);
process.exit(failc ? 1 : 0);
