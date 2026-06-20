/**
 * Load `.env` (if present) before config is parsed. Uses Node's built-in loader
 * (Node 20.12+/22+) so no dependency is needed. Imported first by config.ts.
 * In hosted environments that inject real env vars, the missing-file case is a no-op.
 */
import process from "node:process";

try {
  process.loadEnvFile();
} catch {
  // no .env file — rely on the platform's injected env vars
}
