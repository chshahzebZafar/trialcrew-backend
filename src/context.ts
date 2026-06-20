import { AsyncLocalStorage } from "node:async_hooks";

/** The authenticated user resolved per request. */
export interface AuthUser {
  userId: string; // our DB User id
  clerkId?: string;
  email?: string;
  name?: string;
}

/**
 * Request-scoped current user. The auth hook calls `userStore.enterWith(user)` so
 * the data layer can read the caller without threading userId through every method.
 * Unset → demo mode (repo falls back to the seeded demo user).
 */
export const userStore = new AsyncLocalStorage<AuthUser>();

export const currentAuthUser = (): AuthUser | undefined => userStore.getStore();
