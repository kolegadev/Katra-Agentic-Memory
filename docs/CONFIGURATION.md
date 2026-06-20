# Configuration Guide

## Environment Variables

All configuration is via environment variables (or `.env` file). See `.env.example` for the template.

### Core

| Variable | Default | Description |
|---|---|---|
| `KATRA_API_KEY` | (auto-generated) | API key for REST API authentication |
| `MCP_API_KEY` | (auto-generated) | Dedicated MCP auth key (your agent sends this) |
| `HOST_MCP_PORT` | `3112` | **Host port** mapped to the MCP server (point your agent here) |
| `HOST_API_PORT` | `9012` | **Host port** mapped to the REST API + dashboard |
| `PORT` | `9002` | REST API port **inside the container** |
| `MCP_PORT` / `MCP_PORT_INTERNAL` | `3100` | MCP server port **inside the container** |
| `HOST` | `0.0.0.0` | Bind address |

**Port mapping:** `docker-compose.yml` maps `HOST_MCP_PORT:3112 → container:3100` and
`HOST_API_PORT:9012 → container:9002`. Configure your agent with the **host ports**
(`3112`/`9012`), not the internal container ports.

**API key auto-generation:** If `MCP_API_KEY` and `KATRA_API_KEY` are not set in `.env`,
Katra generates cryptographically random keys on first startup, persists them in the
`system_settings` collection in MongoDB, and prints them to the server logs. Generated
keys are reused on subsequent restarts. Set explicit values in `.env` to disable
auto-generation (recommended for production).

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

Katra supports any OpenAI-compatible LLM provider. Configure via either the legacy pattern or the multi-provider pattern.

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

If no LLM keys are configured, Katra runs in **local-only mode** (no AI summarization/extraction, but all storage and search still work).

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
- **katra** — Katra server (external `HOST_API_PORT:9012` → internal `9002`; external `HOST_MCP_PORT:3112` → internal `3100`)

Customize by editing `docker-compose.yml` or overriding env vars in `.env`.

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
