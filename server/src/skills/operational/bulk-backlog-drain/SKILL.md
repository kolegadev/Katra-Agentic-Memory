---
name: bulk-backlog-drain
title: Bulk Drain of Satori Distillation Backlogs
category: operational
description: Bulk-process the episodic_events distillation backlog with the purpose-built scripts/drain-backlog.mjs (bounded concurrency, Redis locks, processing_log idempotency, runs inside the katra-server container). Use when the backlog is large (10k+ unprocessed events), the health check FAILs on background_processor for a long time, a drain died mid-run leaving stale 'processing' entries, or the user asks to bulk process / bulk distill memories. The live background processor throttles to 12 conversation events per 30s cycle — it is NOT the tool for a large backlog.
status: stable
observation_count: 2
success_count: 2
failure_count: 0
confidence: 0.85
triggers:
  - bulk drain
  - drain backlog
  - bulk process
  - bulk distillation
  - semantic distillation
  - backlog
  - unprocessed events
  - stuck backlog
  - distill memories
  - backlog clearing
  - drain-backlog
  - bulk-drain
  - large backlog
  - unprocessed count
created_at: 2026-08-13T00:00:00.000Z
source: manual-request
---
# Bulk Drain of Satori Distillation Backlogs

Bulk-process the episodic-event distillation backlog using the purpose-built script. The live server's background processor throttles conversation events to 12 per 30s cycle **by design** — a backlog of 100k+ events would take weeks to drain that way. `scripts/drain-backlog.mjs` runs the **same pipeline** (extraction, entity resolution, dispatch, `processing_log` idempotency, Redis locks) with bounded concurrency and **no per-cycle bottleneck**.

## When to Use This Skill

- The user asks to bulk-process, bulk-distill, or clear the memory backlog
- `get_background_status` / health check reports a large `unprocessed` count that is not dropping
- A previous drain died mid-run, leaving stale `processing` log entries
- The health check FAILs on `background_processor` (backlog ≥ 500) and the true count is much larger than the status endpoint's 1000-cap

## The Tool

**`scripts/drain-backlog.mjs`** (repo root, canonical copy) — a Node script that runs **inside the `katra-server` container** so it reuses the exact build and services as live processing (same LLM config, same DB, vector parity).

What it does:
- Pass 1: triages system events (heartbeat, task_execution, …) without LLM, full speed
- Pass 2: conversation events through a bounded worker pool (`CONCURRENCY`), with tiered extraction (skip <50 chars, regex 50–199, LLM ≥200) inside the extraction service
- Short-circuits dispatched records that re-enter the queue via `store_event` (`content.description` without `content.message`) — prevents self-perpetuating refill
- Clears stale `processing` idempotency entries (>30 min) at startup and periodically — a crashed drain must never permanently block its events
- Redis distributed locks + `processing_log` idempotency make it **safe to run alongside the live server**
- **Embeddings are intentionally NOT written** — run `scripts/backfill-embeddings.mjs` and `scripts/backfill-episodic-embeddings.mjs` afterwards

Env vars: `CONCURRENCY=4` (parallel workers, default 4), `MAX=0` (cap for smoke runs, 0 = all), `BATCH=1000` (events per fetch), `TRIAGE_SYSTEM=1` (system-event pass), `SHARDS=1` / `SHARD=0` (sharded mode, see below).

## Sharded Mode (parallel workers)

`SHARDS=N SHARD=i` splits the backlog into N disjoint slices on the first hex chars of `content_hash` (uniform for sha256-style hashes), so N drain workers never contend for the same events. Events missing `content_hash` belong to shard 0. Example — 3 workers:

```bash
docker exec -d -e CONCURRENCY=8 -e BATCH=500 -e SHARDS=3 -e SHARD=0 katra-server sh -c 'node /app/scripts/drain-backlog.mjs > /tmp/katra-drain-shard0.log 2>&1'
docker exec -d -e CONCURRENCY=8 -e BATCH=500 -e SHARDS=3 -e SHARD=1 katra-server sh -c 'node /app/scripts/drain-backlog.mjs > /tmp/katra-drain-shard1.log 2>&1'
docker exec -d -e CONCURRENCY=8 -e BATCH=500 -e SHARDS=3 -e SHARD=2 katra-server sh -c 'node /app/scripts/drain-backlog.mjs > /tmp/katra-drain-shard2.log 2>&1'
```

Each worker exits when its own slice is empty. Redis locks + `processing_log` idempotency remain the safety net regardless of sharding.

### Splitting the load across LLM providers

The extraction LLM call resolves per **process env** (env vars only — the DB `llm_config` override is not applied on the drain code path). To pin a worker to a specific provider, launch it with `LLM_PROVIDERS=<name>` plus `LLM_PROVIDER_<NAME>_{API_KEY,BASE_URL,MODEL}` and blank out the other provider keys so nothing else registers:

```bash
# Grok worker (shard 1) — OpenAI-compatible endpoint; reasoning models get
# LLM_REASONING_EFFORT=low so extraction stays fast/cheap (sent only when set)
docker exec -d -e CONCURRENCY=8 -e BATCH=500 -e SHARDS=3 -e SHARD=1 \
  -e LLM_REASONING_EFFORT=low \
  -e LLM_PROVIDERS=grok \
  -e LLM_PROVIDER_GROK_API_KEY=xai-... \
  -e LLM_PROVIDER_GROK_BASE_URL=https://api.x.ai/v1 \
  -e LLM_PROVIDER_GROK_MODEL=<exact model id> \
  -e DEEPSEEK_API_KEY= -e OPENAI_API_KEY= -e MOONSHOT_API_KEY= -e OLLAMA_API_KEY= \
  katra-server sh -c 'node /app/scripts/drain-backlog.mjs > /tmp/katra-drain-shard1.log 2>&1'

# Gemini worker (shard 2) — OpenAI-compatible endpoint
docker exec -d -e CONCURRENCY=8 -e BATCH=500 -e SHARDS=3 -e SHARD=2 \
  -e LLM_PROVIDERS=gemini \
  -e LLM_PROVIDER_GEMINI_API_KEY=AIza... \
  -e LLM_PROVIDER_GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/ \
  -e LLM_PROVIDER_GEMINI_MODEL=<exact model id> \
  -e DEEPSEEK_API_KEY= -e OPENAI_API_KEY= -e MOONSHOT_API_KEY= -e OLLAMA_API_KEY= \
  katra-server sh -c 'node /app/scripts/drain-backlog.mjs > /tmp/katra-drain-shard2.log 2>&1'
```

Confirm each worker's log shows `✅ LLM Provider validated: <name>` (a failed validation means bad key/model and the worker will fail every extraction — stop it, fix, relaunch). Since each provider has its own rate limits, per-provider throughput multiplies; extraction quality can vary slightly by model, which is acceptable for backlog clearing.

## Run Procedure

1. **Assess** (read-only): get the true backlog size from Mongo, not the status endpoint (which caps at 1000):
   ```bash
   MONGO_PASS=$(grep -E '^MONGO_PASS=' .env | head -1 | cut -d= -f2-)
   docker exec katra-mongo mongosh "mongodb://admin:${MONGO_PASS}@127.0.0.1:27017/katra?authSource=admin" --quiet --eval 'db.getSiblingDB("katra").episodic_events.countDocuments({"metadata.processed": {$ne: true}, "metadata.terminal_failure": {$ne: true}})'
   ```
2. **Copy the script into the container** (the image does not bake `scripts/`):
   ```bash
   docker exec katra-server mkdir -p /app/scripts
   docker cp scripts/drain-backlog.mjs katra-server:/app/scripts/drain-backlog.mjs
   ```
3. **Smoke test** first — 10 events, 2 workers; confirm `0 failed` and real extraction:
   ```bash
   docker exec -e CONCURRENCY=2 -e MAX=10 katra-server node /app/scripts/drain-backlog.mjs
   ```
4. **Launch the full drain** in the background, logging to a file:
   ```bash
   docker exec -e CONCURRENCY=8 -e BATCH=500 katra-server node /app/scripts/drain-backlog.mjs > /tmp/katra-drain.log 2>&1 &
   ```
5. **Monitor**: `tail -f /tmp/katra-drain.log` — progress lines every 50 events (`~N/s`), periodic sweeps. Watch the `failed` counter: small numbers are retryable, a climbing failure count means an upstream problem (LLM key/quota, extraction service) — stop, fix, relaunch (the script is **resumable**: failures are logged and retried on the next run).
6. **Verify by DB count** (not the status endpoint):
   ```bash
   # unprocessed should be strictly decreasing; per-run completion:
   db.processing_log.countDocuments({status:"completed", processor_id: {$regex: /^bulk-drain-/}})
   ```
7. **After the drain**: run the two embedding backfills (see above), then re-run `scripts/python/katra_health_check.py` — `background_processor` flips to OK once the true backlog is under 500.

## Failure Modes

- **Drain dies mid-run** → its in-flight `processing` entries are stuck in `processing`. Next drain run clears them automatically (30-min cutoff at startup). The live server also self-heals these now (see Seed Incident) — an entry older than 30 min never blocks its event permanently.
- **Rate limiting / extraction failures** → counted in `failed`, event marked `metadata.processing_failed`, retried on the next run. If `failed` climbs steadily, check the LLM key and `extraction-service` config before relaunching.
- **Backlog count not dropping** → check the log: `skipped` dominating means locks held elsewhere or hard-dedup marking events processed (that is progress, not a stall — `skipped` from `isHardDeduped` means the event was already completed). `fetch failed` repeatedly means DB connection trouble.
- **MAX smoke run exits with remaining backlog** → expected; relaunch without `MAX`.

## Seed Incidents

- **2026-08-13 — backlog stuck at 130k for weeks; drain died at 10:21 leaving 890 stale entries:** a `bulk-drain` run (PID 157287) created `processing` log entries and died mid-run. The server's idempotency check matched `status: $in ['processing','completed']` and returned **without marking the event processed**, so the same 12 oldest events were re-skipped every 30s cycle and the queue never advanced. Two-part fix, both live in the repo:
  - Server fix (`server/src/services/processing/background-processor.ts`): idempotency hit on `completed` now calls `mark_event_processed` (event leaves the queue); stale `processing` entries are cleared and retried; extraction failures now mark the log entry `failed` instead of leaving it dangling; log updates target only the live entry. Deployed by rebuilding the image (`docker compose build server && docker compose up -d server`).
  - Backlog fix: deleted the 890 stale entries, then ran `drain-backlog.mjs` (this skill). Earlier runs that day (09:00, 10:00) had already completed ~34k events; the full drain is resumable and idempotent, so overlapping runs are safe.
- **2026-08-13 — DeepSeek empty-memory problem:** extraction returned empty results at a 1500-token thinking budget; the budget was raised to 4000 tokens. The empty-extraction path marks events processed with `reason: no_meaningful_information` — expected for genuinely content-less events, not a bug.

## Critical Rules

- **Use the drain script, not the live processor, for large backlogs.** The 12-per-cycle throttle exists to keep live latency low — it is not a backlog tool.
- **Never "fix" a draining backlog** — verify the DB count is decreasing between checks.
- **The status endpoint caps `unprocessed_count` at 1000** — always measure the true backlog in Mongo.
- **Post-drain embeddings are part of the job** — distillation without embeddings leaves retrieval blind.
