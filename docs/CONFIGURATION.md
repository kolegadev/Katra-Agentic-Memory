# Configuration Guide

## Environment Variables

All configuration is via environment variables (or `.env` file). See `.env.example` for the template.

## Security Configuration

Satori stores API keys as SHA-256 hashes in MongoDB. Plaintext keys exist only in `.env` or the one-time console output at generation time.

| Variable | Default | Description |
|---|---|---|
| `KATRA_API_KEY` | (auto-generated) | Admin API key — required for admin operations (`set_memory_scope`, `configure_llm`, tenant management) |
| `MCP_API_KEY` | (auto-generated) | MCP agent key — your agent sends this for memory operations |
| `ADMIN_API_KEY` | — | Legacy alias for `KATRA_API_KEY` |

**Key storage**: Only SHA-256 hashes are persisted to MongoDB `system_settings`. Validation hashes the incoming token and compares against the stored digest using constant-time comparison — the database never holds a value that grants API access directly.

**Key auto-generation**: If both keys are unset, Satori generates 256-bit random keys on first boot, prints them to `docker logs`, and persists the hashes. Subsequent restarts reuse the stored hashes.

### Core Ports

| Variable | Default | Description |
|---|---|---|
| `HOST_MCP_PORT` | `3112` | MCP port on host (point your agent here) |
| `HOST_API_PORT` | `9012` | REST API port on host |
| `PORT` | `9002` | REST API port inside container |
| `MCP_PORT` / `MCP_PORT_INTERNAL` | `3100` | MCP port inside container |
| `HOST` | `0.0.0.0` | Bind address |

### MongoDB

| Variable | Default | Description |
|---|---|---|
| `MONGODB_URI` | (required) | MongoDB connection string |
| `DATABASE_NAME` | `katra` | Database name within MongoDB |
| `MONGODB_URI_FALLBACK` | — | Fallback URI (e.g. Atlas when local is down) |

Example: `mongodb://admin:password@mongo:27017/katra?authSource=admin`

### Redis

| Variable | Default | Description |
|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL |

### LLM Provider

Satori supports any OpenAI-compatible LLM provider. Configure via either the legacy pattern or the multi-provider pattern.

**Legacy (single provider):**
| Variable | Description |
|---|---|
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `MOONSHOT_API_KEY` | Moonshot/Kimi API key |

**Multi-provider:**
| Variable | Description |
|---|---|
| `LLM_PROVIDERS` | Comma-separated list: `deepseek,openai,custom` |
| `LLM_PROVIDER_DEEPSEEK_API_KEY` | DeepSeek key (multi-provider mode) |
| `LLM_PROVIDER_DEEPSEEK_MODEL` | Default model (default: `deepseek-chat`) |
| `LLM_PROVIDER_OPENAI_API_KEY` | OpenAI key |
| `LLM_PROVIDER_OPENAI_MODEL` | Default model (default: `gpt-4o-mini`) |
| `LLM_PROVIDER_CUSTOM_API_KEY` | Custom provider key |
| `LLM_PROVIDER_CUSTOM_BASE_URL` | Custom OpenAI-compatible endpoint |
| `LLM_PROVIDER_CUSTOM_MODEL` | Default model |

If no LLM keys are configured, Satori runs in **local-only mode** (no AI summarization/extraction, but all storage and search still work).

### Embeddings

| Variable | Default | Description |
|---|---|---|
| `EMBEDDING_PROVIDER` | `local` | `local` (@xenova/transformers) or `openai` |
| `EMBEDDING_API_KEY` | — | Required if using OpenAI embeddings |
| `EMBEDDING_MODEL` | `all-MiniLM-L6-v2` | Model name (local: Xenova model, OpenAI: `text-embedding-3-small`) |

**Local embeddings** (default): Zero external API cost. Uses `@xenova/transformers` with `all-MiniLM-L6-v2` (384-dimensional vectors). Runs on Raspberry Pi.

**OpenAI embeddings**: Higher quality, requires `EMBEDDING_API_KEY`. Uses `text-embedding-3-small` (1536-dimensional) by default.

### Object Storage (S3/MinIO)

| Variable | Default | Description |
|---|---|---|
| `S3_ENDPOINT` | `http://localhost:9000` | S3-compatible endpoint |
| `AWS_ACCESS_KEY_ID` | `minioadmin` | Access key |
| `AWS_SECRET_ACCESS_KEY` | `minioadmin` | Secret key |
| `S3_REGION` | `us-east-1` | Region |
| `S3_BUCKET_NAME` | `katra-assets` | Bucket name |

### Background Processing

| Variable | Default | Description |
|---|---|---|
| `BACKGROUND_PROCESSOR_INTERVAL` | `30000` | Processing cycle interval (ms) |

## Docker Compose

The included `docker-compose.yml` starts:
- **mongo** — MongoDB 7.0 (internal port 27017, not exposed to host)
- **redis** — Redis 7 Alpine (internal port 6379, not exposed to host)
- **minio** — MinIO (internal port 9000 API / 9001 console, not exposed to host)
- **katra** — Satori server (external `HOST_API_PORT:9012` → internal `9002`; external `HOST_MCP_PORT:3112` → internal `3100`)

Customize by editing `docker-compose.yml` or overriding env vars in `.env`.

## Connecting to External Services

You can run Satori without Docker Compose by connecting to external services:

```bash
# .env
MONGODB_URI=mongodb+srv://user:pass@cluster.mongodb.net/katra
REDIS_URL=redis://my-redis-host:6379
S3_ENDPOINT=https://s3.amazonaws.com
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
```

Then run Satori directly:
```bash
cd server
npm install
node esbuild.config.mjs
node --import dotenv/config build/index.js
```
