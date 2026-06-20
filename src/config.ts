import "./loadEnv.js";
import { z } from "zod";

const Env = z.object({
  PORT: z.coerce.number().default(4000),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().optional(),
  CLERK_SECRET_KEY: z.string().optional(),
  CLERK_WEBHOOK_SECRET: z.string().optional(),
  // Cloudflare R2 (S3-compatible) — for Day-0 proof uploads.
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET: z.string().optional(),
  R2_PUBLIC_URL: z.string().optional(),
});

export const config = Env.parse(process.env);

/** Feature flags — each layer activates only when its env is configured. */
export const dbEnabled = !!config.DATABASE_URL;
export const clerkEnabled = !!config.CLERK_SECRET_KEY;
export const r2Enabled = !!(
  config.R2_ACCOUNT_ID &&
  config.R2_ACCESS_KEY_ID &&
  config.R2_SECRET_ACCESS_KEY &&
  config.R2_BUCKET
);
