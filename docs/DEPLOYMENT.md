# Deployment Guide

## Local Docker (Recommended)

```bash
git clone https://github.com/kolegadev/katra.git
cd katra
cp .env.example .env
# Edit .env — set MCP_API_KEY, KATRA_API_KEY, and optional LLM keys
docker compose up -d
```

Your agent connects to the **host-mapped ports**:

| Endpoint | Default URL |
|---|---|
| MCP | `http://localhost:3112/mcp` |
| REST API + Dashboard | `http://localhost:9012` |
| Dashboard UI | `http://localhost:9012/dashboard/` |
| Health | `http://localhost:3112/health` |

Inside the container the server binds to `9002` (REST) and `3100` (MCP). The host ports are controlled by `HOST_API_PORT` and `HOST_MCP_PORT` in `.env`.

### Docker Build Details

The Dockerfile uses `node:20-slim` (Debian-based, glibc) and builds with **esbuild** (not `tsc`). This is because `tsc` requires significant RAM and will OOM on devices like Raspberry Pi (8GB). esbuild transpiles all TypeScript files in ~80ms. `node:20-slim` is required for the ONNX runtime used by `@xenova/transformers` local embeddings — Alpine/musl does not work.

```dockerfile
FROM node:20-slim AS builder
# ... install deps, build with esbuild ...
FROM node:20-slim
EXPOSE 3100 9002
CMD ["node", "build/index.js"]
```

## Running Without Docker

Prerequisites: Node.js 20+, MongoDB 7+, Redis 7+, (optional) MinIO

```bash
cd server
npm install
node esbuild.config.mjs

# Set environment variables
export MONGODB_URI="mongodb://admin:password@localhost:27017/katra?authSource=admin"
export REDIS_URL="redis://localhost:6379"
export KATRA_API_KEY="your-admin-key"
export MCP_API_KEY="your-mcp-key"  # Optional, falls back to KATRA_API_KEY
export DEEPSEEK_API_KEY="sk-..."   # Optional

node build/index.js
```

When running directly on the host, the default ports are `9002` (REST) and `3100` (MCP).

## Connecting to External Services

Katra can use managed cloud services:

```bash
# MongoDB Atlas
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/katra

# Redis Cloud / Upstash
REDIS_URL=rediss://default:password@redis.upstash.io:6379

# AWS S3 (instead of MinIO)
S3_ENDPOINT=https://s3.amazonaws.com
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

## Watcher Deployment

The watchers live in `watcher/` and run on the host (outside Docker) so they can
read your agent session files.

```bash
mkdir -p ~/.solomem ~/.katra
cp watcher/katra_watcher.py ~/.solomem/memory_watcher.py
cp watcher/katra_opencode_extractor.py ~/.solomem/opencode_extractor.py
cp watcher/claude_history_extractor.py ~/.solomem/claude_history_extractor.py
cp watcher/kolega_code_extractor.py ~/.solomem/kolega_code_extractor.py
cp watcher/watcher-config.example.json ~/.solomem/watcher-config.json

# Edit config with your API key and platform paths
$EDITOR ~/.solomem/watcher-config.json

# Backfill existing history
python3 ~/.solomem/memory_watcher.py --once --config ~/.solomem/watcher-config.json

# Install systemd service for continuous collection
mkdir -p ~/.config/systemd/user
cp watcher/katra-watcher.service ~/.config/systemd/user/memory-watcher.service
systemctl --user daemon-reload
systemctl --user enable --now memory-watcher
```

On macOS use `launchctl` with a `~/Library/LaunchAgents/com.katra.memory-watcher.plist`
instead of systemd.

## Nginx Reverse Proxy

If you run Katra behind Nginx, proxy the **host-mapped ports** (`9012`/`3112` by
default; adjust if you changed `HOST_API_PORT`/`HOST_MCP_PORT`):

```nginx
server {
    listen 80;
    server_name katra.example.com;

    # REST API
    location /api/ {
        proxy_pass http://127.0.0.1:9012;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # MCP (needs SSE support)
    location /mcp {
        proxy_pass http://127.0.0.1:3112;
        proxy_set_header Host $host;
        proxy_set_header Connection '';
        proxy_http_version 1.1;
        proxy_buffering off;  # Critical for SSE
        proxy_cache off;
        chunked_transfer_encoding on;
    }

    # Dashboard
    location / {
        proxy_pass http://127.0.0.1:9012;
        proxy_set_header Host $host;
    }
}
```

## TLS/HTTPS

Use Let's Encrypt with certbot:

```bash
sudo certbot --nginx -d katra.example.com
```

Or use Caddy for automatic TLS:

```
katra.example.com {
    reverse_proxy /api/* 127.0.0.1:9012
    reverse_proxy /mcp 127.0.0.1:3112
    reverse_proxy /dashboard* 127.0.0.1:9012
    reverse_proxy / 127.0.0.1:9012
}
```

## SaaS / Multi-Tenant Mode

Katra supports database-per-tenant isolation for SaaS deployments.

### Enable Multi-Tenancy

```bash
# .env
MULTI_TENANT=true
KATRA_API_KEY=your-admin-key   # Admin key for tenant management
```

### Tenant Lifecycle

```bash
# Create a tenant (returns API key — save it!)
curl -X POST http://localhost:9012/api/v1/tenants \
  -H "Authorization: Bearer your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme Corp","email":"admin@acme.com","plan":"pro"}'

# List tenants
curl http://localhost:9012/api/v1/tenants \
  -H "Authorization: Bearer your-admin-key"

# Update tenant (change plan, deactivate)
curl -X PATCH http://localhost:9012/api/v1/tenants/TENANT_ID \
  -H "Authorization: Bearer your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{"plan":"enterprise"}'

# Regenerate API key
curl -X POST http://localhost:9012/api/v1/tenants/TENANT_ID/regenerate-key \
  -H "Authorization: Bearer your-admin-key"

# Delete tenant (drops their database — GDPR right-to-erasure)
curl -X DELETE "http://localhost:9012/api/v1/tenants/TENANT_ID?confirm=true" \
  -H "Authorization: Bearer your-admin-key"
```

### How It Works

- Each tenant gets a unique API key (`katra_<random>`)
- Each tenant gets a separate MongoDB database (`katra_tnt_<id>`)
- `AsyncLocalStorage` propagates tenant context through the request lifecycle
- Admin key (`KATRA_API_KEY`) can manage tenants; tenant keys can only access their own data
- Plans: `free` (100MB, 1 user), `pro` (1GB, 10 users), `enterprise` (10GB, 100 users)

## Cloud (Terraform)

AWS Terraform module included in `terraform/aws/` — provisions VPC, ECS Fargate,
DocumentDB, ElastiCache Redis, S3, and ALB. See `terraform/aws/README.md` for
variables and usage.

## Kubernetes (Helm)

Helm chart included in `helm/katra/` — supports Bitnami MongoDB + Redis subcharts,
ingress with path routing, HPA, and PDB. See `helm/katra/README.md` for values and
installation instructions.

## Running on Raspberry Pi

Katra is designed to run on a Raspberry Pi 5 (16GB):

1. Use Docker Compose (recommended)
2. If building locally, use `node esbuild.config.mjs` (not `tsc`)
3. Local embeddings (`@xenova/transformers`) work on ARM64
4. Default memory usage: ~384MB total (MongoDB 254MB, Katra 52MB, MinIO 73MB, Redis 5MB)

## Health Monitoring

```bash
# Simple health check (MCP endpoint)
curl http://localhost:3112/health

# Admin API health
curl -H "Authorization: Bearer YOUR_KEY" http://localhost:9012/api/v1/health

# Full diagnostics
curl -H "Authorization: Bearer YOUR_KEY" http://localhost:9012/api/v1/admin/diagnostics
```

## Running the Test Suite

Katra includes 87 tests across 9 files (unit, security, and integration):

```bash
cd server
npm install
npm test                    # All unit + security tests (< 1s, no Docker needed)
npm run test:integration    # Integration tests (Docker stack required)
npm run test:coverage       # With coverage report
```

See [SECURITY.md](SECURITY.md) for the security regression test suite.
