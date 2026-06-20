/**
 * Data-layer selector. Routes call `repo.*` and never import a concrete store.
 *
 *   DATABASE_URL set   → Postgres (src/prismaRepo.ts)
 *   otherwise (default) → in-memory (src/store.ts) — zero setup, runs anywhere.
 *
 * The `Repo` interface is derived from the in-memory store so both implementations
 * are guaranteed (at compile time) to expose the same methods + shapes, just async.
 */
import { config } from "./config.js";
import { store } from "./store.js";

type Store = typeof store;
export type Repo = {
  [K in keyof Store]: (
    ...args: Parameters<Store[K]>
  ) => Promise<Awaited<ReturnType<Store[K]>>>;
};

/** Wrap the synchronous in-memory store as an async Repo. */
const memoryRepo = Object.fromEntries(
  Object.entries(store).map(([key, fn]) => [
    key,
    async (...args: unknown[]) => (fn as (...a: unknown[]) => unknown)(...args),
  ]),
) as Repo;

let active: Repo = memoryRepo;
export let driver: "memory" | "postgres" = "memory";

if (config.DATABASE_URL) {
  const { prismaRepo } = await import("./prismaRepo.js");
  active = prismaRepo;
  driver = "postgres";
}

export const repo = active;
