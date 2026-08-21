# Configuration Guide

All configuration is via environment variables (or `.env` file). See `.env.example` for the template. The recommended setup path is `install.sh`:

```bash
curl -fsSL https://raw.githubusercontent.com/kolegadev/Katra-Agentic-Memory/main/install.sh | bash
```

It generates `.env` with real secrets (Mongo and MinIO credentials), brings the stack up, and prints the agent config.

## Authentication & Identity

Katra resolves **who is calling** from the API key presented on each request — via the `X-MCP-Auth` header, `Authorization: Bearer ...`, or the `?token=` URL parameter — never from client self-report. Identity records map SHA-256 key hashes to `user_id`s in MongoDB `system_settings.client_keys`. Plaintext keys exist only in the one-time console output at generation time.

| Variable | Default | Description |
|---|---|---|
| `KATRA_API_KEY` | (auto-generated) | Admin API key. Authenticates as **trusted satori** — required for admin REST operations (e.g. `PUT /api/v1/admin/identity`, per-identity `?user_id=` lookups) and privileged MCP tools (`set_memory_scope`, `configure_llm`) |
| `MCP_API_KEY` | — | **Legacy — retired.** Pre-cutover shared agent key. No longer authenticates: since the 2026-08-21 identity cutover, keys must map to an identity in `client_keys`. A valid-but-unmapped key is rejected with **401 + reason** (loud failure, no silent fallback) |
| `ADMIN_API_KEY` | — | **Legacy — retired.** Old alias for `KATRA_API_KEY`, kept only for historical installs |
| `BACKUP_MCP_KEYS` | — | **Legacy — retired.** Comma-separated backup keys from the pre-cutover era; no longer authenticate |

**Client key provisioning**: at boot, `ensureClientKeys()` idempotently provisions `system_settings.client_keys`:

- `satori` — mapped to the legacy env-key hash (no new key generated)
- `shoshin` (iMac trading Kolega Code) and `zanshin` (iMac OpenCode desktop) — freshly generated **once**; plaintext is printed exactly once in the "Client keys (identity separation)" block of the server log; only SHA-256 hashes are stored in the database
- `gas-law-watcher` — tool actor that writes team memory only and is never allocated autonomous tasks

**Key storage**: Only SHA-256 hashes are persisted to MongoDB `system_settings`. Validation hashes the incoming token and compares against the stored digest using constant-time comparison — the database never holds a value that grants API access directly.

**Key auto-generation**: If `KATRA_API_KEY` is unset, Katra generates a 256-bit random key on first boot, prints it to `docker logs`, and persists the hash. Subsequent restarts reuse the stored hash.

### Endpoints

| Endpoint | Port | Notes |
|---|---|---|
| MCP (streamable-http, POST-only) | `3112` (host) / `3100` (container) | `http://<host>:3112/mcp` — point your agent here |
| Admin REST API | `9012` (host) / `9002` (container) | `http://<host>:9012/api/v1/` |
| Dashboard | `9012` | `http://<host>:9012/dashboard/` |
| Health | both | `GET /health` on the MCP port, `GET /api/v1/health` on the API port |

### Core Ports

| Variable | Default | Description |
|---|---|---|
| `HOST_MCP_PORT` | `3112` | MCP port on host (point your agent here) |
| `HOST_API_PORT` | `9012` | REST API + dashboard port on host |
| `PORT` | `9002` | REST API port inside container |
| `MCP_PORT` / `MCP_PORT_INTERNAL` | `3100` | MCP port inside container |
| `HOST` | `0.0.0.0` | Bind address |

### Persistence

| Variable | Default | Description |
|---|---|---|
| `DATA_DIR` | `./data` | Where all persistent data lives (MongoDB, Redis, MinIO volumes) — e.g. `/mnt/usb-secrets/katra` |

### MongoDB

| Variable | Default | Description |
|---|---|---|
| `MONGO_USER` | `admin` | MongoDB root user |
| `MONGO_PASS` | (required) | MongoDB root password — must also appear inline in `MONGODB_URI` |
| `MONGODB_URI` | (required) | MongoDB connection string |
| `DATABASE_NAME` | `katra` | Database name within MongoDB |
| `MONGODB_URI_FALLBACK` | — | Fallback URI (e.g. Atlas when local is down) |

Example: `mongodb://admin:password@mongo:27017/katra?authSource=admin`

### Redis

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://redis:6379` | Redis connection URL |

### LLM Provider

Katra supports any OpenAI-compatible LLM provider: **DeepSeek, OpenAI, Moonshot, Ollama** (local models), or a custom endpoint. Environment variables are read at startup only; the DB-stored config (set via the `configure_llm` MCP tool or the dashboard's Settings page) overrides env vars.

**Provider-specific env vars:**

| Variable | Description |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API key (`DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL` default `deepseek-v4-flash`) |
| `OPENAI_API_KEY` | OpenAI API key (`OPENAI_BASE_URL`, `OPENAI_MODEL` default `gpt-4o`) |
| `MOONSHOT_API_KEY` | Moonshot/Kimi API key (`MOONSHOT_BASE_URL`, `MOONSHOT_MODEL` default `moonshot-v1-8k`) |
| `OLLAMA_API_KEY` | Ollama (value doesn't matter, e.g. `ollama-no-key`); `OLLAMA_BASE_URL` default `http://host.docker.internal:11434/v1`, `OLLAMA_MODEL` default `qwen2.5:3b` |

**Generic multi-provider pattern** (any OpenAI-compatible provider):

| Variable | Description |
|---|---|
| `LLM_PROVIDERS` | Comma-separated list of provider names, e.g. `deepseek,openai,custom` |
| `LLM_PROVIDER_<NAME>_API_KEY` | API key for the named provider |
| `LLM_PROVIDER_<NAME>_BASE_URL` | OpenAI-compatible endpoint for the named provider |
| `LLM_PROVIDER_<NAME>_MODEL` | Default model for the named provider |

If no LLM keys are configured, Katra runs in **local-only mode** (no AI summarization/extraction, but all storage and search still work).

### Embeddings

Embeddings are **always local** — no configuration needed and no remote embedding provider:

- `Xenova/all-MiniLM-L6-v2` (22M params, 384-dimensional vectors) via Transformers.js (ONNX runtime)
- The model downloads automatically on first memory storage and caches in the container
- The Docker image uses `node:20-slim` (Debian/glibc) because the ONNX runtime requires glibc — it does NOT work on Alpine/musl

### Object Storage (S3/MinIO)

| Variable | Default | Description |
|---|---|---|
| `S3_ENDPOINT` | `http://minio:9000` | S3-compatible endpoint |
| `AWS_ACCESS_KEY_ID` | (required) | Server-side access key — must match `MINIO_USER` |
| `AWS_SECRET_ACCESS_KEY` | (required) | Server-side secret key — must match `MINIO_PASS` |
| `S3_REGION` | `us-east-1` | Region |
| `S3_BUCKET_NAME` | `katra-assets` | Bucket name |
| `MINIO_USER` | (required) | MinIO root user seeded at first init |
| `MINIO_PASS` | (required) | MinIO root password seeded at first init |

### Background Processing

| Variable | Default | Description |
|---|---|---|
| `KATRA_DISABLE_BACKGROUND_PROCESSOR` | `false` | Set to `true` to disable the background processor |

The background processor runs on a fixed 30-second cycle (episodic → extraction → semantic → knowledge graph) and is started automatically unless disabled.

### Multi-Tenancy (SaaS mode)

| Variable | Default | Description |
|---|---|---|
| `MULTI_TENANT` | `false` | Set to `true` to enable database-per-tenant isolation |

### Bridge & Wake Scripts (Kolega Code / OpenCode)

These are consumed by the integration and wake scripts, not by the server:

| Variable / File | Description |
|---|---|
| `KATRA_HOST` | Katra host for the bridge self-test and wake rituals (default `localhost`; on the iMacs, set it to this machine's address) |
| `KATRA_USER_ID` | `user_id` to write into the hook config — `satori`, `shoshin`, or `zanshin` (default `satori`) |
| `~/.katra/wake-env.sh` | Per-machine wake settings (`KATRA_HOST`, `KATRA_API_KEY`, `KATRA_USER_ID`); sourced by the wake scripts when env vars are unset |
| `~/.katra/keys/katra-<user>.key` | Per-machine client key file (chmod 600) — fallback when the key isn't in the environment |

The bridge hook config (`integrations/kolega-code/satori-hook.json`) holds `mcp_url` / `api_key` / `user_id` / `sources`; `ensure-bridge.sh` rewrites it when `user_id` or the `mcp_url` host differ from `KATRA_HOST`.

## Docker Compose

The included `docker-compose.yml` starts:
- **mongo** — MongoDB 7.0 (internal port 27017, not exposed to host)
- **redis** — Redis 7 Alpine (exposed on `${HOST_REDIS_PORT:-6384}:6379`)
- **minio** — MinIO (internal port 9000 API / 9001 console, not exposed to host)
- **server** — `katra-server` (external `HOST_API_PORT:9012` → internal `9002`; external `HOST_MCP_PORT:3112` → internal `3100`); also serves the dashboard at `/dashboard/` on the API port

Recommended setup: run `./install.sh` (generates `.env` with real secrets, then brings the stack up and prints your agent config). Manual equivalent: copy `.env.example` → `.env`, set `MONGO_PASS`, `MINIO_USER`, `MINIO_PASS`, then `docker compose up -d --build --wait`. Customize by editing `docker-compose.yml` or overriding env vars in `.env`.

## Connecting to External Services

You can run Katra without Docker Compose by connecting to external services:

```bash
# .env
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/katra
REDIS_URL=redis://my-redis-host:6379
S3_ENDPOINT=https://s3.amazonaws.com
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

Then run Katra directly:
```bash
cd server
npm install
node esbuild.config.mjs
node --import dotenv/config build/index.js
```
