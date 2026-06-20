import { fileURLToPath } from "node:url";
import Fastify, { type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { config, clerkEnabled } from "./config.js";
import { routes } from "./routes.js";
import { setupAuth } from "./auth.js";
import { driver } from "./repo.js";
import { startScheduler } from "./scheduler/index.js";

export function buildServer() {
  const app = Fastify({
    logger: {
      transport: process.env.NODE_ENV === "production" ? undefined : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
    },
  });

  app.register(cors, { origin: true });

  // Keep the raw JSON body (needed for the Svix webhook signature) while still parsing.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
    if (!body) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (e) {
      (e as { statusCode?: number }).statusCode = 400;
      done(e as Error, undefined);
    }
  });

  app.setErrorHandler((err: Error, _req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    reply.status(status).send({ error: { message: err.message, statusCode: status } });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.status(404).send({ error: { message: "Route not found", statusCode: 404 } });
  });

  app.get("/health", () => ({
    status: "ok",
    service: "trialcrew-backend",
    driver,
    auth: clerkEnabled ? "clerk" : "demo",
    ts: new Date().toISOString(),
  }));

  // Auth must be wired onto the root instance (not register()'d) so its onRequest
  // hook applies to the routes below.
  setupAuth(app);
  app.register(routes);

  return app;
}

async function main() {
  const app = buildServer();
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(`data driver: ${driver} · auth: ${clerkEnabled ? "clerk" : "demo"}`);
    // Start the 14-day cadence sweep (no-op without DATABASE_URL).
    await startScheduler();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Only auto-start when run directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
