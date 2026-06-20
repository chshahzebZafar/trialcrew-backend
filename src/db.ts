import { PrismaClient } from "@prisma/client";

/** Prisma client singleton (only instantiated when DATABASE_URL is set → Postgres mode). */
export const prisma = new PrismaClient();
