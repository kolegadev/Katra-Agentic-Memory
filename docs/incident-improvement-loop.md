# Incident → Improvement Loop

> John, 2026-09-14: "run your own optimisation loop for each of the bugs or
> issues you find — an opportunity to not just solve a problem but to
> self-improve."

Every bug or incident we close must end with an **incident card** — not just
the patch. The card's job is to move from *instance* to *class*: the fix
stops this failure; the card stops the failure pattern.

## When

After EVERY incident, outage, data-loss event, cross-agent leak, or
user-reported bug — immediately after the fix is verified. The card takes
three minutes; skipping it is how the same class of failure recurs.

## Card format (seven lines)

```
## INCIDENT-CARD <slug> (<date>)
- WHAT: one-line facts (system, symptom, window).
- ROOT: the actual root cause, not the trigger.
- FIX: what changed, with commit.
- CLASS: the reusable error category (e.g. "unbounded growth under constant
  writers", "identity-derived defaults that don't derive", "least-privilege
  defaults", "model-specific outage with no fallback").
- RULE: one operating rule that prevents the CLASS. Written as an
  imperative, searchable as "OPERATING RULE".
- WHERE: the canonical memory location (one semantic fact, NOT five
  near-duplicate insights — search before storing).
- METRIC: what number proves it worked (before → after, measured).
```

## Storage rules

1. The card is appended to this file AND posted to Katra shared memory
   tagged `incident-improvement` so every agent's wake can find it.
2. Before storing a new RULE in semantic memory, search for an existing
   one — strengthen it (evidence count) instead of duplicating it.
3. The weekly messaging-health report (Sunday 02:30) lists the week's
   cards and asks each agent: which CLASS recurred, and what RULE change
   would have prevented it.

### INCIDENT-CARD dns-blackout-natasha (2026-09-16)
- WHAT: natasha-macbook-pro (Zefir) lost DNS ~08:07–09:38 local 2026-09-16: `kolega-code update` failed (uv couldn't reach PyPI — reported to John as "missing dependencies") and the agent errored on model calls (tiktoken BPE download from openaipublic.blob.core.windows.net failed, [Errno 8]).
- ROOT: link-level outage (Tailscale netcheck "UDP is blocked", derp/control dials "no route to host" by raw IP) surfaced as Tailscale's resolver 100.100.100.100 returning SERVFAIL for every query; macOS does not fail over to secondary resolvers when the primary resolver ANSWERS with SERVFAIL. Amplifier: tiktoken's BPE lived in the per-user temp dir, so a troubleshooting reboot (09:19, shutdown cause 5) forced a runtime re-download mid-outage.
- FIX: reinstall once the link recovered (09:38, 0.39.0); TIKTOKEN_CACHE_DIR pinned to ~/.local/share/tiktoken-cache in .zprofile + .zshrc (Zefir, verified: cl100k_base loads with downloads disabled); machine-health collectors + daily review (integrations/kolega-code/health/machine_health.py every 15 min per machine, health_review.py daily on thebrick) now sample DNS resolvers + live lookups, tailscale state, bridge config and kolega install continuously.
- CLASS: primary-resolver failure with no system failover; runtime-download caches stored in temp storage.
- RULE: OPERATING RULE — runtime-download caches must live in persistent storage (never temp), and every machine's DNS/tailscale/bridge health must be sampled (<=15 min) and reviewed daily — health failures are found by the system, not by a human screenshot.
- WHERE: semantic_facts "OPERATING RULE persistent-caches-health-sampling" (shared).
- METRIC: outage ~90 min, detected only when John screenshot it; now: 15-min sampling + daily review on thebrick and natasha, and tiktoken loads with networking disabled (Zefir's proof).

## Seed cards — first run (2026-09-12 → 2026-09-14)

## Seed cards — first run (2026-09-12 → 2026-09-14)

### INCIDENT-CARD wal-spiral (2026-09-14)
- WHAT: BTC bots stopped writing blocks three times; trades.db WAL grew to ~2GB; engines died staggered with "database is locked".
- ROOT: 15 bot processes write snapshots every 2s, so every SQLite checkpoint mode (PASSIVE/RESTART/TRUNCATE) returned SQLITE_BUSY forever; the WAL grew unbounded, reads slowed, writers exceeded busy_timeout. The earlier PASSIVE-checkpoint change fixed the *old* stall source but not checkpoint starvation itself.
- FIX: busy_timeout 10s→60s; automated maintenance windows every 3h at :02 (stop bots → TRUNCATE checkpoint → start, mid-block, zero missed blocks). Commit c03d031. Backfill reconstructed all missing rows (zero gaps).
- CLASS: unbounded growth under constant writers.
- RULE: OPERATING RULE — any long-running SQLite WAL stack must have a *guaranteed* periodic checkpoint (scheduled writer pause); verify the checkpoint actually completes, not just that it's attempted.
- WHERE: semantic_facts "OPERATING RULE wal-checkpoint-maintenance" (shared).
- METRIC: WAL size 1.9GB → 0 after window; 0 lock errors since; gaps 617 → 0.
- RECURRENCE 2026-09-16 (same class): with the stack grown to 17 writers the WAL regrew ~420MB/h and the 'database is locked' storm returned ~2h after each 3h window (first block error 17:00 BST, 69 lock errors by 17:55). Root: window cadence was not sized to the WAL growth rate — the storm threshold (~0.8-1GB WAL) was crossed before the next window. Strengthened fix: maintenance window moved to HOURLY (:02, Persistent) so the WAL stays ~0.4GB, well under the threshold; verified 18:02 window drains to 0 and 0 lock errors after. RULE strengthened below.
- RULE (strengthened): OPERATING RULE — any long-running SQLite WAL stack must have a *guaranteed* periodic checkpoint (scheduled writer pause) whose cadence is SIZED FROM MEASURED WAL GROWTH so the WAL never approaches the observed lock-storm threshold between windows; verify the checkpoint completes AND that lock errors stay 0 between windows (recurrence means the cadence, not the mechanism, was wrong).

### INCIDENT-CARD inbox-identity (2026-09-12)
- WHAT: satori inbox loop silently ignored all "Attention: Satori" messages; John had to relay them.
- ROOT: loop's MY_NAMES defaulted to pre-cutover legacy names (katra, kolegacode, kolegacoder) instead of deriving from the agent's identity env.
- FIX: MY_NAMES default now derives from KATRA_AGENT_ID/KATRA_USER_ID + legacy aliases; crontab sets names explicitly; install script fixed for all machines. Commits d281ce4, d65f679.
- CLASS: identity-derived defaults that don't derive.
- RULE: OPERATING RULE — anything keyed to an agent's identity must derive its default FROM that identity, never from a frozen name list.
- WHERE: semantic_facts "OPERATING RULE identity-derived-defaults".
- METRIC: synthetic test message listed pending under both env variants; zero missed messages since.

### INCIDENT-CARD scope-leak (2026-09-14)
- WHAT: Zefir's wake pulled Lilly's session summaries; 8,287 session docs sat in the team-shared scope.
- ROOT: session bridges wrote event-category memories with the default shared scope (write-scope default = shared unless private:true), and wake queries searched other agents' names ("Attention: X OR Y OR Z").
- FIX: store_memory(private=True) convention for session data; receipts private; 8,287 docs migrated to private; wake queries narrowed to self only. Commit 86afee1.
- CLASS: least-privilege defaults (defaults that maximise visibility).
- RULE: OPERATING RULE — session-derived data defaults to PRIVATE; only deliberate inter-agent messages go shared; wake searches are self-scoped.
- WHERE: semantic_facts "OPERATING RULE session-data-private".
- METRIC: 8,287 shared session docs → 0.

### INCIDENT-CARD deepseek-flash-outage (2026-09-14)
- WHAT: Zefir's kolega-code hung on every prompt; katra LLM calls silently degrading ("terminated").
- ROOT: DeepSeek's v4-flash inference was hanging for all authenticated requests (reproduced with two keys from two networks) while v4-pro responded in 1.3s — a model-specific outage, not a network fault.
- FIX: switched Zefir's active_model and katra's DEEPSEEK_MODEL to deepseek-v4-pro.
- CLASS: model-specific outage with no fallback.
- RULE: OPERATING RULE — every agent's LLM config needs a known-good alternate model; on provider/model outage, switch, don't wait.
- WHERE: semantic_facts "OPERATING RULE model-fallback".
- METRIC: chat POST v4-flash 20.6s timeout → v4-pro 1.3s OK.
