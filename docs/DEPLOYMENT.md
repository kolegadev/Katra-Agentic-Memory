# Deployment Guide

## Install script (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/kolegadev/Katra-Agentic-Memory/main/install.sh | bash
```

That clones the source to `~/.katra/src`, generates a `.env` with real
credentials, builds and starts the stack, waits for it to report healthy, and
prints the config snippet for connecting your agent.

Docker is the only prerequisite. The installer checks for it and tells you how
to install it if missing; it will not install it for you.

Useful flags:

| Flag | Effect |
|---|---|
| `--with-watcher` | Also install the host-side session watcher (see below) |
| `--with-systemd` | Install the boot unit so Katra starts on reboot (needs sudo) |
| `--rebuild` | Rebuild and recreate just the server container, then verify |
| `--no-start` | Write config but don't start containers |
| `--dir PATH` | Where to clone/find the source (default `~/.katra/src`) |
| `--ref REF` | Install a specific tag, branch or SHA (default `main`) |
| `--uninstall` | Stop the stack, remove units, config and watcher |
| `--purge` | With `--uninstall`, also delete the data directory (needs `--yes`) |

Passing flags through a pipe needs `bash -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/kolegadev/Katra-Agentic-Memory/main/install.sh \
  | bash -s -- --with-watcher --with-systemd
```

The installer never prompts, so it behaves the same piped from `curl`, run in
CI, or driven by an agent. Every flag has an environment equivalent
(`KATRA_HOME`, `KATRA_REF`, `KATRA_WITH_WATCHER=1`, …).

It is also idempotent: re-running it against an existing install keeps your
`.env` untouched and never rotates credentials that are already in use.

### Manual install

If you'd rather do it by hand:

```bash
git clone https://github.com/kolegadev/Katra-Agentic-Memory.git
cd Katra-Agentic-Memory
cp .env.example .env
# Required: MONGO_PASS, MINIO_USER, MINIO_PASS — compose refuses to start
# without them. See "Credentials" below for the two pairs that must match.
docker compose up -d --build --wait
```

### Credentials

Two values are duplicated in `.env` and must be kept in sync by hand. The
installer does this for you; if you edit `.env` yourself, watch for them.

| Must match | Why |
|---|---|
| `MONGO_PASS` and the password inside `MONGODB_URI` | The URI embeds the password inline. Changing only one breaks authentication. |
| `MINIO_USER`/`MINIO_PASS` and `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` | MinIO is seeded with the `MINIO_*` pair; the server authenticates with the `AWS_*` pair. If they diverge, asset storage fails silently while everything else looks fine. |

MinIO requires a user of 3+ characters and a password of 8+ characters.

### Rotating credentials

The two services behave differently, which matters if you are trying to get off
the old `change-me` defaults.

**MongoDB** stores its users inside the database itself.
`MONGO_INITDB_ROOT_PASSWORD` is read **only when the data volume is first
initialised**, so on an existing install editing `MONGO_PASS` in `.env` does not
change the password — it only stops the server from being able to log in. The
password must be changed inside MongoDB first. This is why `install.sh` warns
about `change-me` rather than rewriting it.

**MinIO** re-reads `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` from the
environment on every start, so rotating that pair is just an `.env` edit plus a
container recreate. Stored objects are unaffected.

To rotate MongoDB's password on a live install, change it inside MongoDB
first, then update `.env` to match:

```bash
# 1. Change the password in the running database
docker exec -it katra-mongo mongosh -u admin -p '<old-pass>' --authenticationDatabase admin \
  --eval 'db.getSiblingDB("admin").changeUserPassword("admin", "<new-pass>")'

# 2. Update BOTH places in .env: MONGO_PASS and the password inside MONGODB_URI

# 3. Restart the server only — do not recreate the mongo container
docker compose up -d --force-recreate --wait server
```

For MinIO, set all four values (`MINIO_USER`/`MINIO_PASS` and the matching
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`) in `.env`, then recreate both
containers — MinIO picks up the new root credentials at start, and your objects
are untouched:

```bash
docker compose up -d --force-recreate --wait minio server
```

Starting from scratch is the simplest option if the data is expendable:

```bash
./install.sh --uninstall --purge --yes   # deletes all memory data
./install.sh                            # fresh install, fresh secrets
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
read your agent session files. Because they run on the host, they connect to the
**host-mapped** MCP port (`3112` by default), not the container-internal `3100`.

Everything below is done for you by:

```bash
./install.sh --with-watcher
```

That copies the extractors to `~/.katra`, writes a `watcher-config.json` with
your MCP URL and API key filled in, runs a one-off backfill of existing history,
and installs the scheduler for your platform (systemd user unit on Linux,
launchd agent on macOS).

### Manual watcher install

All watcher files live in `~/.katra`.

```bash
mkdir -p ~/.katra
cp watcher/katra_watcher.py ~/.katra/
cp watcher/katra_opencode_extractor.py ~/.katra/
cp watcher/claude_history_extractor.py ~/.katra/
cp watcher/kolega_code_extractor.py ~/.katra/
cp watcher/watcher-config.example.json ~/.katra/watcher-config.json

# Set mcp_url (host port, e.g. http://localhost:3112/mcp), api_key and platform paths
$EDITOR ~/.katra/watcher-config.json
chmod 600 ~/.katra/watcher-config.json

# Backfill existing history
python3 ~/.katra/katra_watcher.py --once --config ~/.katra/watcher-config.json
```

Then install the scheduler. On **Linux**, render the unit template:

```bash
mkdir -p ~/.config/systemd/user
sed -e "s|__PYTHON__|$(command -v python3)|g" \
    -e "s|__KATRA_HOME__|$HOME/.katra|g" \
    watcher/katra-watcher.service.template > ~/.config/systemd/user/katra-watcher.service
systemctl --user daemon-reload
systemctl --user enable --now katra-watcher
```

This is a *user* unit, so it stops when you log out. To keep collecting while
logged out: `sudo loginctl enable-linger $USER`.

On **macOS**, render the launchd agent:

```bash
mkdir -p ~/Library/LaunchAgents
sed -e "s|__PYTHON__|$(command -v python3)|g" \
    -e "s|__KATRA_HOME__|$HOME/.katra|g" \
    watcher/com.katra.watcher.plist.template > ~/Library/LaunchAgents/com.katra.watcher.plist
launchctl load -w ~/Library/LaunchAgents/com.katra.watcher.plist
```

Check it with `launchctl list | grep katra` and `tail -f ~/.katra/watcher.log`.

Note that `watcher-config.json` is authoritative: values in it override any
`Environment=` set in the systemd unit, so the MCP URL and API key belong in
that file.

## Rebuilding after a code change

```bash
./install.sh --rebuild        # or: scripts/shell/rebuild.sh
```

This rebuilds and recreates **only** the server container, waits for it to
report healthy, and prints a health summary. MongoDB, Redis and MinIO keep
running, so your memory data is untouched.

## Starting on boot

```bash
./install.sh --with-systemd
```

`katra.service.template` is a template — the working directory and user are
filled in per machine, so there is nothing to hand-edit. Do not copy the
template to `/etc/systemd/system/` directly.

Be aware of what the unit is: a **boot trigger, not a process supervisor**. It
runs `docker compose up -d --wait` once, so `systemctl status katra` will read

```
Active: active (exited) since ...
```

which is normal, not an error. What keeps the containers alive after boot is
`restart: unless-stopped` in `docker-compose.yml`.

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
