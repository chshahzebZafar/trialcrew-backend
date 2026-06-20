/**
 * Expo push delivery. Uses the public Expo push API over `fetch` (no SDK dependency).
 * Inert when a tester has no stored token (tokens arrive via `POST /me/push-token`).
 * Failures are logged, never thrown — a flaky push must not fail the cadence sweep.
 */
import type { PushMsg } from "./sweep.js";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/** Send a batch of pushes. Messages without a token are skipped. Returns how many were attempted. */
export async function deliverPushes(messages: PushMsg[]): Promise<number> {
  const sendable = messages.filter((m) => !!m.token);
  if (sendable.length === 0) return 0;

  const payload = sendable.map((m) => ({
    to: m.token,
    title: m.title,
    body: m.body,
    sound: "default" as const,
    data: { kind: m.kind },
  }));

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.error(`[scheduler] expo push HTTP ${res.status}: ${await res.text().catch(() => "")}`);
    }
  } catch (e) {
    console.error("[scheduler] expo push failed:", (e as Error).message);
  }
  return sendable.length;
}
