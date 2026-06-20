/**
 * Clerk auth layer — inert unless CLERK_SECRET_KEY is set.
 *
 *   CLERK_SECRET_KEY unset → no enforcement; the data layer uses the seeded demo user.
 *   CLERK_SECRET_KEY set    → every request (except /health and /webhooks/*) must carry a
 *                             valid Clerk Bearer token; the resolved User id is put on the
 *                             request-scoped context (src/context.ts) for the repo to read.
 *
 * Also registers `POST /webhooks/clerk` to sync user.created/updated/deleted into the DB
 * (Svix-verified). `prisma` is lazy-imported so demo / in-memory mode never loads it.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { createClerkClient, verifyToken } from "@clerk/backend";
import { Webhook } from "svix";
import { config, clerkEnabled, dbEnabled } from "./config.js";
import { userStore, type AuthUser } from "./context.js";

const clerk = clerkEnabled
  ? createClerkClient({ secretKey: config.CLERK_SECRET_KEY })
  : null;

async function resolveUser(req: FastifyRequest): Promise<AuthUser> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) throw new Error("Missing bearer token");

  const claims = await verifyToken(token, { secretKey: config.CLERK_SECRET_KEY! });
  const clerkId = claims.sub;

  const { prisma } = await import("./db.js");
  let user = await prisma.user.findUnique({ where: { clerkId } });
  if (!user) {
    // First request before the webhook landed — pull the profile from Clerk and upsert.
    const cu = await clerk!.users.getUser(clerkId);
    const email =
      cu.primaryEmailAddress?.emailAddress ??
      cu.emailAddresses[0]?.emailAddress ??
      `${clerkId}@clerk.local`;
    const name = [cu.firstName, cu.lastName].filter(Boolean).join(" ") || null;
    user = await prisma.user.upsert({
      where: { clerkId },
      create: { clerkId, email, name },
      update: { email },
    });
  }
  return { userId: user.id, clerkId, email: user.email, name: user.name ?? undefined };
}

/**
 * Wire auth onto the ROOT instance (must NOT be register()'d — an encapsulated
 * plugin's onRequest hook wouldn't apply to sibling route plugins). Call directly:
 * `setupAuth(app)` before registering the routes.
 */
export function setupAuth(app: FastifyInstance) {
  if (clerkEnabled) {
    // Callback-style hook: resolve the user, then call done() INSIDE userStore.run so the
    // request-scoped user propagates into the route handler.
    //
    // IMPORTANT: an `async` hook doing `userStore.enterWith(await resolveUser(req))` does NOT
    // propagate to the handler in Fastify (the await detaches the AsyncLocalStorage context) —
    // the handler then sees no user and the repo falls back to the seeded demo user. Verified
    // with a Fastify repro: enterWith → context lost; run(done) → context kept.
    app.addHook("onRequest", (req, reply, done) => {
      const path = req.url.split("?")[0];
      if (req.method === "OPTIONS" || path === "/health" || path.startsWith("/webhooks/")) return done();
      resolveUser(req)
        .then((user) => userStore.run(user, () => done()))
        .catch(() => reply.code(401).send({ error: { message: "Unauthorized", statusCode: 401 } }));
    });
  }

  // Clerk → DB user sync. No-op unless both the webhook secret and a DB are configured.
  app.post("/webhooks/clerk", async (req, reply) => {
    if (!config.CLERK_WEBHOOK_SECRET || !dbEnabled) {
      return reply.send({ ok: true, skipped: true });
    }
    const raw = (req as FastifyRequest & { rawBody?: string }).rawBody;
    if (!raw) return reply.code(400).send({ error: { message: "Missing raw body", statusCode: 400 } });

    let evt: { type: string; data: Record<string, unknown> };
    try {
      const wh = new Webhook(config.CLERK_WEBHOOK_SECRET);
      evt = wh.verify(raw, {
        "svix-id": req.headers["svix-id"] as string,
        "svix-timestamp": req.headers["svix-timestamp"] as string,
        "svix-signature": req.headers["svix-signature"] as string,
      }) as typeof evt;
    } catch {
      return reply.code(400).send({ error: { message: "Invalid signature", statusCode: 400 } });
    }

    const { prisma } = await import("./db.js");
    const data = evt.data as {
      id: string;
      email_addresses?: { email_address: string }[];
      first_name?: string | null;
      last_name?: string | null;
    };
    if (evt.type === "user.created" || evt.type === "user.updated") {
      const email = data.email_addresses?.[0]?.email_address ?? `${data.id}@clerk.local`;
      const name = [data.first_name, data.last_name].filter(Boolean).join(" ") || null;
      await prisma.user.upsert({
        where: { clerkId: data.id },
        create: { clerkId: data.id, email, name },
        update: { email, name },
      });
    } else if (evt.type === "user.deleted") {
      await prisma.user.deleteMany({ where: { clerkId: data.id } });
    }
    return reply.send({ ok: true });
  });
}
