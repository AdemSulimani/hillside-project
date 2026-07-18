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

# P3-2: stamp the commit into the image so a partially-rolled deploy is diagnosable.
# With two services (api + worker) running off ONE image, "new api / old worker" is the likeliest
# incident shape, and nothing in the running containers currently identifies which build they are.
ARG BUILD_SHA=unknown
ENV BUILD_SHA=${BUILD_SHA}
LABEL org.opencontainers.image.revision=${BUILD_SHA}

EXPOSE 8000
ENV PORT=8000

# The API entrypoint, and the only process that runs migrations.
#
# P3-2: the `worker` compose service OVERRIDES this with `command: ["node","dist/worker.js"]` —
# deliberately, because migrations must be applied by exactly one process. With two services built
# from this image, leaving the default here would have both race the migrator on every deploy.
CMD ["sh", "-c", "node dist/db/migrate.js && node dist/server.js"]
