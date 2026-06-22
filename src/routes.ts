import type { FastifyInstance } from "fastify";
import { z, type ZodTypeAny } from "zod";
import { repo } from "./repo.js";
import { createProofUploadUrl } from "./storage.js";

function parse<S extends ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw Object.assign(new Error(r.error.issues.map((i) => i.message).join(", ")), { statusCode: 400 });
  }
  return r.data;
}

const notFound = <T>(v: T): NonNullable<T> => {
  if (v === null || v === undefined) throw Object.assign(new Error("Not found"), { statusCode: 404 });
  return v as NonNullable<T>;
};

const idParam = z.object({ id: z.string().min(1) });
const rewardType = z.enum(["PREMIUM_ACCESS", "CREDITS", "STIPEND"]);
const role = z.enum(["TESTER", "FOUNDER"]);

export async function routes(app: FastifyInstance) {
  // ── Tester ──────────────────────────────────────────────────────────────────
  app.get("/me/profile", () => repo.getProfile());
  app.patch("/me/profile", (req) => {
    const input = parse(
      z.object({
        name: z.string().min(2).optional(),
        vertical: z.string().min(2).optional(),
        categories: z.array(z.string()).optional(),
        bio: z.string().max(280).optional(),
      }),
      req.body,
    );
    return repo.updateProfile(input);
  });
  app.get("/feedback/questions", () => repo.getFeedbackQuestions());

  app.post("/me/push-token", (req) => {
    const { token } = parse(z.object({ token: z.string().min(1) }), req.body);
    return repo.setPushToken(token);
  });
  app.post("/me/test-push", () => repo.sendTestPush());
  app.post("/me/role", (req) => {
    const { isFounder, isProfessional } = parse(
      z.object({ isFounder: z.boolean(), isProfessional: z.boolean() }),
      req.body,
    );
    return repo.setRole(isFounder, isProfessional);
  });

  app.get("/me/notifications", () => repo.getNotifications());
  app.post("/me/notifications/read", () => repo.markNotificationsRead());
  app.get("/campaigns/matched", () => repo.getBrowseCampaigns());
  app.get("/me/cycles", () => repo.getCycles());

  app.get("/cycles/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    return notFound(await repo.getCycle(id));
  });

  app.post("/campaigns/:id/opt-in", (req) => {
    const { id } = parse(idParam, req.params);
    return repo.optIn(id);
  });

  app.post("/cycles/:id/proof/upload-url", (req) => {
    const { id } = parse(idParam, req.params);
    const { contentType } = parse(z.object({ contentType: z.string().default("image/jpeg") }), req.body ?? {});
    return createProofUploadUrl(id, contentType);
  });

  app.post("/cycles/:id/proof", (req) => {
    const { id } = parse(idParam, req.params);
    const { screenshotUrl } = parse(z.object({ screenshotUrl: z.string().url().or(z.string().min(1)) }), req.body);
    return repo.submitProof(id, screenshotUrl);
  });

  app.post("/cycles/:id/checkins/:day", (req) => {
    const { id, day } = parse(z.object({ id: z.string(), day: z.coerce.number().refine((d) => [3, 7, 10, 14].includes(d), "Invalid check-in day") }), req.params);
    const { response } = parse(z.object({ response: z.string().min(1) }), req.body);
    return repo.respondCheckIn(id, day as 3 | 7 | 10 | 14, response);
  });

  app.post("/cycles/:id/daily-checkin", (req) => {
    const { id } = parse(idParam, req.params);
    return repo.dailyCheckIn(id);
  });

  app.patch("/cycles/:id/email", (req) => {
    const { id } = parse(idParam, req.params);
    const { gmail } = parse(z.object({ gmail: z.string().email() }), req.body);
    return repo.updateCycleEmail(id, gmail);
  });

  app.post("/cycles/:id/feedback", (req) => {
    const { id } = parse(idParam, req.params);
    const { answers } = parse(z.object({ answers: z.record(z.union([z.string(), z.number(), z.boolean()])) }), req.body);
    return repo.submitFeedback(id, answers);
  });

  app.post("/cycles/:id/claim-reward", (req) => {
    const { id } = parse(idParam, req.params);
    return repo.claimReward(id);
  });

  // ── Founder ─────────────────────────────────────────────────────────────────
  app.get("/me/apps", () => repo.getFounderApps());
  app.get("/me/testers", () => repo.getFounderTesters());
  app.get("/me/founder-stats", () => repo.getFounderStats());

  app.get("/apps/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    return notFound(await repo.getFounderApp(id));
  });
  app.get("/apps/:id/enrollments", (req) => {
    const { id } = parse(idParam, req.params);
    return repo.getEnrollments(id);
  });
  app.get("/apps/:id/emails", (req) => {
    const { id } = parse(idParam, req.params);
    return repo.exportEmails(id);
  });
  app.get("/enrollments/:id", async (req) => {
    const { id } = parse(idParam, req.params);
    return notFound(await repo.getEnrollment(id));
  });

  app.post("/apps", (req) => {
    const input = parse(z.object({
      name: z.string().min(2), packageName: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i, "Invalid package name"),
      vertical: z.string().min(2), feedbackFocus: z.string().min(3),
      description: z.string().optional(), playStoreUrl: z.string().url().optional(), rewardType,
    }), req.body);
    return repo.submitApp(input);
  });

  app.patch("/apps/:id", (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(z.object({
      name: z.string().min(2), packageName: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/i, "Invalid package name"),
      vertical: z.string().min(2), feedbackFocus: z.string().min(3),
      description: z.string().optional(), playStoreUrl: z.string().url().optional(), rewardType,
    }), req.body);
    return repo.updateApp(id, input);
  });

  app.post("/apps/:id/publish", (req) => {
    const { id } = parse(idParam, req.params);
    const input = parse(z.object({ minTesters: z.number().int().min(12), startDate: z.string() }), req.body);
    return repo.publishApp(id, input);
  });

  app.post("/apps/:id/invited", (req) => {
    const { id } = parse(idParam, req.params);
    const { testLink } = parse(z.object({ testLink: z.string().url().optional() }), req.body ?? {});
    return repo.markInvited(id, testLink);
  });

  app.post("/apps/:id/end", (req) => {
    const { id } = parse(idParam, req.params);
    return repo.endCohort(id);
  });

  // Testing aid — seed fake testers into your own app (owner-scoped).
  app.post("/apps/:id/seed-testers", (req) => {
    const { id } = parse(idParam, req.params);
    const { count } = parse(z.object({ count: z.number().int().positive().optional() }), req.body ?? {});
    return repo.seedTestEnrollments(id, count);
  });

  app.post("/testers/:id/rate", (req) => {
    const { id } = parse(idParam, req.params);
    return repo.rateTester(id);
  });

  app.post("/enrollments/:id/rate", (req) => {
    const { id } = parse(idParam, req.params);
    return repo.rateEnrollment(id);
  });

  // ── Broadcasts ──────────────────────────────────────────────────────────────
  app.get("/broadcasts", (req) => {
    const { packageName } = parse(z.object({ packageName: z.string().min(1) }), req.query);
    return repo.getBroadcasts(packageName);
  });
  app.post("/broadcasts", (req) => {
    const { packageName, message } = parse(z.object({ packageName: z.string().min(1), message: z.string().min(1) }), req.body);
    return repo.sendBroadcast(packageName, message);
  });
  app.get("/broadcasts/:id/replies", (req) => {
    const { id } = parse(idParam, req.params);
    return repo.getReplies(id);
  });
  app.post("/broadcasts/:id/replies", (req) => {
    const { id } = parse(idParam, req.params);
    const { authorName, authorRole, message } = parse(z.object({ authorName: z.string().min(1), authorRole: role, message: z.string().min(1) }), req.body);
    return repo.postReply(id, authorName, authorRole, message);
  });
}
