# --- build ---
FROM node:22-bookworm-slim AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- run ---
FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
# tsc does not emit .sql files; migrate.js reads dist/db/migrations at runtime
COPY --from=builder /app/src/db/migrations ./dist/db/migrations

EXPOSE 8000
ENV PORT=8000

CMD ["sh", "-c", "node dist/db/migrate.js && node dist/server.js"]
