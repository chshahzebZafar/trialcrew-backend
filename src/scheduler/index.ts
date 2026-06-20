/**
 * Scheduler bootstrap. Like the DB/auth/R2 layers, it's **env-gated**: with no `DATABASE_URL`
 * there's nothing to schedule against, so it's a no-op. When Postgres is configured it boots
 * pg-boss and runs the cadence sweep hourly. pg-boss is lazy-imported so the in-memory boot
 * path never loads it.
 */
import { config, dbEnabled } from "../config.js";

const QUEUE = "cycle-sweep";
const CRON_HOURLY = "0 * * * *";

let started = false;

export async function startScheduler(): Promise<void> {
  if (started) return;
  if (process.env.SCHEDULER_DISABLED === "true") {
    console.log("[scheduler] disabled via SCHEDULER_DISABLED (e.g. a local backend sharing a deployed DB).");
    return;
  }
  if (!dbEnabled) {
    console.log("[scheduler] off — no DATABASE_URL (the 14-day cadence runs only on Postgres).");
    return;
  }
  try {
    const [{ PgBoss }, { runSweepOnce }] = await Promise.all([import("pg-boss"), import("./runner.js")]);
    const boss = new PgBoss({ connectionString: config.DATABASE_URL });
    boss.on("error", (e: unknown) => console.error("[scheduler] pg-boss error:", e));
    await boss.start();
    await boss.createQueue(QUEUE);
    await boss.work(QUEUE, async () => {
      const r = await runSweepOnce();
      console.log(`[scheduler] sweep — scanned=${r.cyclesScanned} reminders=${r.remindersSent} missed=${r.checkInsMissed} dropped=${r.cyclesDropped} pushes=${r.pushesDelivered}`);
    });
    await boss.schedule(QUEUE, CRON_HOURLY);
    started = true;
    console.log(`[scheduler] on — '${QUEUE}' runs every hour (${CRON_HOURLY}).`);
  } catch (e) {
    // A scheduler failure must not take down the API.
    console.error("[scheduler] failed to start:", (e as Error).message);
  }
}
