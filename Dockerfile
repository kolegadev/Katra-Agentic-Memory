# ── Katra Server Dockerfile ────────────────────────────────────────
# Multi-stage build: compile TypeScript, then copy to runtime image.
# The result is a self-contained image — no bind mounts needed.
#
# Uses node:20-slim (Debian-based) because the ONNX runtime (used by
# @xenova/transformers for local embeddings) requires glibc.
# Alpine/musl does NOT work — the ONNX .node binary needs glibc.
# node:20-slim includes glibc on both arm64 and x64 architectures.

# ── Stage 1: Build ─────────────────────────────────────────────────
FROM node:20-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install ALL deps (including devDeps for build)
COPY server/package*.json ./
RUN npm install

# Copy source and build
COPY server/ ./
RUN node esbuild.config.mjs

# ── Stage 2: Runtime ───────────────────────────────────────────────
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install production deps only
COPY server/package*.json ./
RUN npm install --production && npm cache clean --force

# Pre-download the embedding model (~80MB) so it's baked into the image.
# Without this, the model downloads at first startup which can timeout or fail
# on slow connections, leaving embeddings permanently disabled.
RUN node -e "const{ pipeline }=require('@xenova/transformers');(async()=>{await pipeline('feature-extraction','Xenova/all-MiniLM-L6-v2');console.log('Model cached');})().catch(e=>{console.warn('Model pre-download failed (non-fatal):',e.message);process.exit(0);})"

# Copy built artifacts from builder stage
COPY --from=builder /app/build ./build

# Copy dashboard (static HTML)
COPY dashboard/ ./dashboard/

# Expose ports: MCP (3100) + Admin API (9002)
EXPOSE 3100 9002

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -sf http://localhost:9002/api/v1/health || exit 1

CMD ["node", "build/index.js"]
