#!/usr/bin/env node
/**
 * Contract check: asserts the mobile front-end and this backend stay in sync.
 * Static analysis only — no server/DB needed, so it's CI-safe.
 *
 *   node scripts/check-contract.mjs [backendDir] [mobileDir]
 *   (defaults: "." and "../mobile")
 *
 * Verifies:
 *   1. Every endpoint the mobile real client calls (path + HTTP method) exists on the backend.
 *   2. Every shared type interface has identical fields on both sides.
 * Exits non-zero on any mismatch.
 */
import fs from "node:fs";
import path from "node:path";

const BACKEND = path.resolve(process.argv[2] ?? ".");
const MOBILE = path.resolve(process.argv[3] ?? "../mobile");

let failures = 0;
const fail = (m) => { failures++; console.log("  ✖ " + m); };
const ok = (m) => console.log("  ✓ " + m);
const info = (m) => console.log("  ~ " + m);

function read(p) {
  try { return fs.readFileSync(p, "utf8"); }
  catch { console.error(`\nCannot read ${p} — pass correct [backendDir] [mobileDir].`); process.exit(2); }
}

// Normalize a path: ${expr} and :param → :id, drop query string.
const norm = (p) => p.replace(/\$\{[^}]+\}/g, ":id").replace(/:[A-Za-z_]+/g, ":id").replace(/\?.*$/, "");

// ── 1. Endpoints ──────────────────────────────────────────────────────────────
// Extract ONLY each http<...>(...) call's own arguments (balanced parens) so a
// later fetch(...) PUT in the same function can't be mistaken for the http method.
function extractHttpCalls(src, set) {
  const re = /http<[^>]*>\(/g;
  let m;
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1; // the '(' of http(
    let depth = 0, end = -1;
    for (let i = open; i < src.length; i++) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")" && --depth === 0) { end = i; break; }
    }
    if (end === -1) continue;
    const args = src.slice(open + 1, end);
    const pm = args.match(/^\s*[`"]([^`"]+)[`"]/);
    if (!pm) continue;
    const p = norm(pm[1]);
    let method = "GET";
    const mm = args.match(/method:\s*"([A-Z]+)"/);
    if (mm) method = mm[1];
    else if (/json:/.test(args)) method = "POST";
    set.add(`${method} ${p}`);
  }
}

function mobileEndpoints() {
  const set = new Set();
  extractHttpCalls(read(path.join(MOBILE, "src/api/realClient.ts")), set);
  extractHttpCalls(read(path.join(MOBILE, "src/lib/upload.ts")), set);
  return set;
}

function backendEndpoints() {
  const set = new Set();
  const collect = (src) => {
    for (const m of src.matchAll(/app\.(get|post|patch|put|delete)\(\s*"([^"]+)"/g)) {
      set.add(`${m[1].toUpperCase()} ${norm(m[2])}`);
    }
  };
  collect(read(path.join(BACKEND, "src/routes.ts")));
  collect(read(path.join(BACKEND, "src/server.ts")));
  collect(read(path.join(BACKEND, "src/auth.ts")));
  return set;
}

// ── 2. Type interfaces ────────────────────────────────────────────────────────
function interfaces(file) {
  const out = {};
  for (const m of read(file).matchAll(/export interface (\w+)\s*\{([\s\S]*?)\n\}/g)) {
    out[m[1]] = new Set([...m[2].matchAll(/^\s*(\w+)\??:/gm)].map((x) => x[1]));
  }
  return out;
}

// ── Run ───────────────────────────────────────────────────────────────────────
console.log("\n[1] Endpoints — every mobile call must exist on the backend");
const me = mobileEndpoints();
const be = backendEndpoints();
for (const e of [...me].sort()) {
  be.has(e) ? ok(e) : fail(`mobile calls "${e}" — no matching backend route`);
}
const infra = new Set(["GET /health", "POST /webhooks/clerk"]);
for (const e of [...be].sort()) {
  if (!me.has(e) && !infra.has(e)) info(`backend route never called by mobile: "${e}"`);
}

console.log("\n[2] Types — shared interfaces must have identical fields");
const mt = interfaces(path.join(MOBILE, "src/types/index.ts"));
const bt = interfaces(path.join(BACKEND, "src/types.ts"));
const mobileOnly = new Set(["SubmitAppInput", "PublishInput"]); // request inputs, validated inline on the backend
for (const n of Object.keys(mt).sort()) {
  if (mobileOnly.has(n)) continue;
  if (!bt[n]) { info(`${n}: mobile-only type (no backend counterpart)`); continue; }
  const miss = [...mt[n]].filter((f) => !bt[n].has(f));
  const extra = [...bt[n]].filter((f) => !mt[n].has(f));
  if (miss.length || extra.length) fail(`${n}: mobile-only=[${miss}] backend-only=[${extra}]`);
  else ok(n);
}

console.log("");
if (failures) {
  console.log(`✖ Contract check FAILED — ${failures} mismatch(es) between mobile and backend.`);
  process.exit(1);
}
console.log("✓ Contract check passed — mobile and backend are in sync.");
