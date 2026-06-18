# Deployment Guide

## Local Docker (Recommended)

```bash
git clone https://github.com/kolegadev/katra.git
cd katra
cp .env.example .env
# Edit .env
docker compose up -d
```

### Docker Build Details

The Dockerfile uses `node:20-alpine` and builds with **esbuild** (not `tsc`). This is because `tsc` requires significant RAM and will OOM on devices like Raspberry Pi (8GB). esbuild transpiles all 46 TypeScript files in ~80ms.

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY server/package*.json ./
RUN npm install --production
COPY server/ ./
RUN node esbuild.config.mjs
EXPOSE 9002 3100
CMD ["node", "--import", "dotenv/config", "build/index.js"]
```

## Running Without Docker

Prerequisites: Node.js 20+, MongoDB 7+, Redis 7+, (optional) MinIO

```bash
cd server
npm install
node esbuild.config.mjs

# Set environment variables
export MONGODB_URI="mongodb://admin:password@localhost:27017/katra?authSource=admin"
export REDIS_URL="localhost:6379"
export KATRA_API_KEY="your-key"
export DEEPSEEK_API_KEY="sk-..." # Optional

node build/index.js
```

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

## Systemd Service for Watcher

```bash
# Install watcher
mkdir -p ~/.katra
cp watcher/katra_watcher.py ~/.katra/
cp watcher/watcher-config.example.json ~/.katra/watcher-config.json
# Edit config with your paths and API key

# Install systemd service
mkdir -p ~/.config/systemd/user
cp watcher/katra-watcher.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now katra-watcher
```

## Nginx Reverse Proxy

```nginx
server {
    listen 80;
    server_name katra.example.com;

    # REST API
    location /api/ {
        proxy_pass http://127.0.0.1:9002;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    # MCP (needs SSE support)
    location /mcp {
        proxy_pass http://127.0.0.1:3100;
        proxy_set_header Host $host;
        proxy_set_header Connection '';
        proxy_http_version 1.1;
        proxy_buffering off;  # Critical for SSE
        proxy_cache off;
        chunked_transfer_encoding on;
    }

    # Dashboard
    location / {
        root /path/to/katra/dashboard;
        try_files $uri /index.html;
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
    reverse_proxy /api/* 127.0.0.1:9002
    reverse_proxy /mcp 127.0.0.1:3100
    root * /path/to/katra/dashboard
    file_server
}
```

## Running on Raspberry Pi

Katra is designed to run on a Raspberry Pi 5 (8GB):

1. Use Docker Compose (recommended)
2. If building locally, use `node esbuild.config.mjs` (not `tsc`)
3. Local embeddings (`@xenova/transformers`) work on ARM64
4. Default memory usage: ~500MB total (MongoDB + Redis + Node)

## Health Monitoring

```bash
# Simple health check
curl http://localhost:9002/api/v1/health

# Full diagnostics
curl -H "Authorization: Bearer YOUR_KEY" http://localhost:9002/api/v1/admin/diagnostics

# MCP health
curl http://localhost:3100/health
```
