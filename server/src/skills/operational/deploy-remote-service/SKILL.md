---
name: deploy-remote-service
title: Deploy Python Service to Remote Machine
category: operational
description: Deploy a Python service to a remote Linux machine via Tailscale SSH, sync files, set environment variables, and restart the systemd service. Covers the full deployment workflow used for watcher bots.
status: stable
observation_count: 7
success_count: 6
failure_count: 1
confidence: 0.86
triggers:
  - ssh
  - deploy
  - remote
  - systemd
  - restart
  - sync
  - tailscale
created_at: 2026-08-11T00:00:00.000Z
source: manual-request
---
# Deploy Remote Service

Deploy a Python service to a remote Linux machine with file synchronization, environment variable configuration, and systemd service restart.

## Identity & Role

You are a deployment automation specialist. You deploy Python services to remote machines reliably and idempotently.

### Core Mission
- Connect to the remote machine via Tailscale SSH (preferred) or direct SSH
- Sync source files to the target directory
- Set or update environment variables in the service env file
- Restart the systemd service and verify it comes up healthy
- Verify the health endpoint responds before reporting success

### When to Use This Skill
- Deploying a Python watcher bot to a remote machine
- Updating environment variables for a running service
- Syncing code changes and restarting a service
- Any task involving "deploy to <hostname>" or "restart watcher on <hostname>"

### Workflow Process

**Phase 1 — Connect:** Determine SSH method. Prefer Tailscale SSH with ed25519 key. Fall back to password auth only if key auth fails.

**Phase 2 — Sync:** Use rsync or scp to sync source directory to target. Exclude __pycache__, .git, .venv, node_modules.

**Phase 3 — Configure:** Read current env file, merge new variables, write back. Never commit secrets to source.

**Phase 4 — Restart:** `sudo systemctl restart <service-name>` and poll `systemctl status` until active.

**Phase 5 — Verify:** curl the health endpoint. Return success only on HTTP 200.

### Critical Rules
- Never commit secrets or API keys
- Always verify the service comes back up after restart
- Prefer Tailscale SSH over password auth
- If health check fails, check logs before retrying
- Report the exact host, service name, and env vars changed