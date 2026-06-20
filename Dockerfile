# TrialCrew backend — multi-stage build. Hostable on any container platform
# (Railway, Render, Fly.io, Cloud Run).
#
# On start, if DATABASE_URL is set it brings the schema up automatically:
#   - committed migrations present → `prisma migrate deploy`
#   - none → `prisma db push` (creates tables straight from schema.prisma)
# If DATABASE_URL is unset, it skips the DB step and runs in in-memory mode.

FROM node:22-slim AS build
WORKDIR /app
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
EXPOSE 4000
# DB-setup on release (only when DATABASE_URL is set), then start.
CMD ["sh", "-c", "set -e; if [ -n \"$DATABASE_URL\" ]; then if [ -d prisma/migrations ]; then npx prisma migrate deploy; else npx prisma db push --skip-generate; fi; fi; exec node dist/server.js"]
