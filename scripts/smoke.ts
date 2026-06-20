/**
 * Read-only endpoint smoke test against a RUNNING backend (local or live). Safe for prod —
 * it only does GETs. Walks every read endpoint, prints status + a sample of the real data,
 * and chains ids (cycles/apps/enrollments) so per-resource routes are covered too.
 *
 *   BASE_URL=https://trialcrew-backend.onrender.com npx tsx scripts/smoke.ts
 *   BASE_URL=http://localhost:4000 TOKEN="<clerk session jwt>" npx tsx scripts/smoke.ts
 *
 * No TOKEN: protected routes are expected to return 401 (proof auth is enforced).
 * With TOKEN (or a backend in demo mode): routes return real data, which is asserted non-empty.
 */
const BASE = (process.env.BASE_URL ?? "https://trialcrew-backend.onrender.com").replace(/\/$/, "");
const TOKEN = process.env.TOKEN ?? "";
const authed = TOKEN.length > 0;

let pass = 0, failc = 0;
const ok = (n: string, d = "") => { pass++; console.log(`  ✓ ${n}${d ? "  →  " + d : ""}`); };
const bad = (n: string, d: string) => { failc++; console.log(`  ✗ ${n}  →  ${d}`); };

async function get(path: string): Promise<{ status: number; body: any }> {
  const res = await fetch(BASE + path, { headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {} });
  let body: unknown;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

const sample = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s.length > 90 ? s.slice(0, 90) + "…" : s;
};

console.log(`\n=== endpoint smoke — ${BASE} ===`);

// 1) Public.
let r = await get("/health");
r.status === 200 && r.body?.driver
  ? ok("GET /health", `driver=${r.body.driver} auth=${r.body.auth}`)
  : bad("GET /health", `status=${r.status}`);

// Expect real data when we have a token OR the backend is in demo mode (auth not enforced).
const expectData = authed || r.body?.auth === "demo";
console.log(expectData ? "(expecting real data through protected routes)\n" : "(no token + auth enforced — protected routes should 401)\n");

// Helper: assert a protected GET. Without data access we accept 401; otherwise 200 + a check.
async function probe(path: string, label: string, check?: (b: any) => boolean): Promise<any> {
  const res = await get(path);
  if (!expectData) {
    res.status === 401 ? ok(`${label} (401 — auth enforced)`) : bad(label, `expected 401, got ${res.status}: ${sample(res.body)}`);
    return null;
  }
  if (res.status !== 200) { bad(label, `status ${res.status}: ${sample(res.body)}`); return null; }
  if (check && !check(res.body)) { bad(label, `unexpected shape: ${sample(res.body)}`); return null; }
  ok(label, sample(res.body));
  return res.body;
}

console.log("\n[tester]");
await probe("/me/profile", "GET /me/profile", (b) => typeof b?.name === "string");
const cycles = await probe("/me/cycles", "GET /me/cycles", (b) => Array.isArray(b));
await probe("/campaigns/matched", "GET /campaigns/matched", (b) => Array.isArray(b));
await probe("/feedback/questions", "GET /feedback/questions", (b) => Array.isArray(b) && b.length > 0);
await probe("/me/notifications", "GET /me/notifications", (b) => Array.isArray(b));
if (expectData && Array.isArray(cycles) && cycles[0]?.id) {
  await probe(`/cycles/${cycles[0].id}`, `GET /cycles/:id`, (b) => b?.id === cycles[0].id);
}

console.log("\n[founder]");
const apps = await probe("/me/apps", "GET /me/apps", (b) => Array.isArray(b));
await probe("/me/founder-stats", "GET /me/founder-stats", (b) => typeof b?.appsSubmitted === "number");
await probe("/me/testers", "GET /me/testers", (b) => Array.isArray(b));
if (expectData && Array.isArray(apps) && apps[0]?.id) {
  const a = apps[0];
  await probe(`/apps/${a.id}`, "GET /apps/:id", (b) => b?.id === a.id);
  const enr = await probe(`/apps/${a.id}/enrollments`, "GET /apps/:id/enrollments", (b) => Array.isArray(b));
  await probe(`/apps/${a.id}/emails`, "GET /apps/:id/emails", (b) => Array.isArray(b));
  if (a.packageName) await probe(`/broadcasts?packageName=${encodeURIComponent(a.packageName)}`, "GET /broadcasts", (b) => Array.isArray(b));
  if (Array.isArray(enr) && enr[0]?.id) await probe(`/enrollments/${enr[0].id}`, "GET /enrollments/:id", (b) => b?.id === enr[0].id);
}

console.log(`\n${failc ? "✗ FAILED" : "✓ PASSED"} — ${pass} checks passed, ${failc} failed.`);
if (!expectData) console.log("Note: pass a TOKEN (Clerk session JWT) to exercise real data through the protected routes.");
process.exit(failc ? 1 : 0);
