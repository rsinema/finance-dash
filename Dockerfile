### Stage 1: build the React frontend ###
# Pin to native build platform — Vite/esbuild crashes under QEMU emulation.
# The dist output (JS/HTML/CSS) is portable, so this is safe for multi-arch images.
FROM --platform=$BUILDPLATFORM oven/bun:1.3-alpine AS web-builder
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY web/package.json ./web/
COPY server/package.json ./server/

RUN bun install --frozen-lockfile || bun install

COPY web ./web
RUN bun --filter web build


### Stage 2: server runtime ###
FROM oven/bun:1.3-alpine AS server
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/

RUN bun install --frozen-lockfile --production || bun install --production

COPY server ./server
COPY --from=web-builder /app/web/dist ./web/dist

ENV NODE_ENV=production
# EXPOSE is metadata only; actual port comes from $PORT (default 8090) in env_file.
EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT:-8090}/api/health" || exit 1

CMD ["bun", "run", "server/src/index.ts"]
