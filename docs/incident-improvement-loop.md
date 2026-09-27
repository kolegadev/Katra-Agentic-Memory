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

### INCIDENT-CARD health-alert-undeliverable (2026-09-26)
- WHAT: thebrick's daily machine-health review (07:30 cron) posted CARD DUE / PROBLEM alerts on 2026-09-19..09-26; every one was undeliverable — 0/8 dispatched, 0 handled, and no session ever closed the CARD DUE list.
- ROOT: the alerts could never satisfy the satori inbox loop's candidate query, for two independent reasons across the period: (1) SELF-AUTHORED — while the alerting identity was the local one, the alert was authored by the target identity itself, and the loop's candidate query excludes events authored by its own AGENT_ID ("not authored by me") — a self-authored alert is invisible to its own loop by construction; (2) UNFETCHABLE NAME — from 2026-09-26 the env-driven identity default (KATRA_USER_ID unset in the cron → "katra") addressed the alert "Attention: Katra"; the legacy alias exists only in MY_NAMES (applied after the store query), not in the store-side name filter (KNOWN_AGENTS), so no loop even fetched it.
- FIX: health_review.py now AUTHORs alerts as the system identity (KATRA_ALERT_AUTHOR, default "katra") while ADDRESSING the local identity (KATRA_USER_ID) — author ≠ consuming loop and recipient ∈ its fetchable names; unresolved identity warns loudly (target == author). thebrick cron line sets KATRA_USER_ID=satori. Commit 63cf482 (feat/imagination-engine).
- CLASS: an alerting control whose delivery path cannot reach any owning consumer — failures are silent because the alert, not its absence, is invisible.
- RULE: OPERATING RULE — every automated alert must have a verified delivery path to an owning process: the alert's author must differ from the owner loop's identity, the recipient must be a name the owner loop actually fetches, and delivery must be proven end-to-end (post → pending → handled) when the control is deployed or changed; an alert no process can consume is not a control.
- WHERE: semantic_facts "OPERATING RULE alert-delivery-proof" (shared).
- METRIC: alerts dispatched 2026-09-19..26 = 0/8; after the fix the re-emitted 2026-09-26 alert (id 61f8dfb9) landed as a pending inbox message the same minute and was closed by reply 66cea6ce — the first dispatchable machine-health alert in the loop's history; next natural delivery 2026-09-27 06:30Z.

### INCIDENT-CARD natasha-katra-unreachable-blips (2026-09-27)
- WHAT: MacBook-Pro-2.local degraded 9 of 87 samples in the 2026-09-26 05:15Z -> 2026-09-27 05:30Z review window — 8x 'katra unreachable' / 'bridge self-test returned no context (dead-bridge fingerprint)' alarms on the session bridge, 1x DNS blackout (09-26 15:01Z, controlplane.tailscale.com + openaipublic.blob.core.windows.net); every episode recovered inside one sampling interval; machine ok at review time (kolega-code 0.40.0).
- ROOT: transient unreachability of the remote Katra host (thebrick:9012) during WAN/tunnel blips — the SessionStart self-test cannot return context without Katra, so it trips the 'dead-bridge fingerprint'; the bridge itself is intact (09-26 diagnosis: '<urlopen error timed out>' to thebrick:9012 — NOT DNS, NOT bridge corruption; 872908b removed a clock-jump amplifier that had faked a 3,214,496 ms probe). The 15:01Z sample co-times with thebrick's 15:00-15:15Z DNS blackout = one shared link event.
- FIX: none needed in code — the alarm is correctly fail-loud and reason-attributed ('katra unreachable' is named separately from the fingerprint); operational mitigation is gateway kickstart on flaps; durable natasha DNS fixes A/C remain keyboard/console-gated.
- CLASS: dependency unavailability presented as a local control failure — a monitor whose self-test requires a remote dependency cannot distinguish 'remote dependency down' from 'local wiring broken' without cross-host probing.
- RULE: OPERATING RULE — attribute before repair: when a health alarm names a dependency (or a dependency-requiring self-test returns no context), probe the remote dependency host FIRST; an unreachable dependency is a reachability symptom, not local corruption — do not touch local bridge wiring until the remote host answers.
- WHERE: semantic_facts "OPERATING RULE attribute-before-repair" (shared, my-team).
- METRIC: 9/87 samples degraded; longest streak 2 samples (13:10-13:20Z); all self-recovered within 1 interval; zero unnecessary bridge repairs; window closed with the remote host answering and the bridge serving.

### INCIDENT-CARD thebrick-dns-blips (2026-09-27)
- WHAT: thebrick degraded 4 of 105 samples in the 2026-09-26 05:15Z -> 2026-09-27 06:30Z review window — 05:15Z (pypi.org + controlplane.tailscale.com), 09:15Z (transient bridge self-test alarm), 15:00Z DOWN (pypi + tailscale + azure blob failing together), 15:15Z (pypi + tailscale); nothing degraded since 15:15Z (>15 h clean).
- ROOT: link-level DNS blackout — MULTIPLE independent public endpoints failing at the same instant = villa Wi-Fi/upstream degradation (the known residual failure mode after the 09-25 netis-resolver fix); the same 15:00Z blip hit MacBook-Pro-2.local = shared WAN event. The 09:15Z bridge alarm was transient and self-recovered (bridge-guard re-asserts registrations every 10 min).
- FIX: none new — pinned resolvers (1.1.1.1/8.8.8.8) + ignore-auto-dns remain correct and unchanged since 09-25; residual link drops are below resolver-layer control. CARD DUE single-sample threshold tuning stays John-pending (not applied unilaterally).
- CLASS: link degradation presenting as name-resolution failure — symptoms mimic resolver misconfiguration, so the failure gets chased in config instead of the link.
- RULE: OPERATING RULE — a DNS failure hitting multiple independent external endpoints at the same moment is a link/upstream event, not resolver configuration: don't re-tune; verify recovery, keep the pinned config, and treat blips that self-recover within one sampling interval as link noise unless they recur in bursts or persist.
- WHERE: semantic_facts "OPERATING RULE dns-blackout-is-link-event" (shared, my-team).
- METRIC: 4/105 samples degraded (1 down); longest streak 2 samples (15:00-15:15Z); >15 h clean since; zero DNS config changes in response; degradation attributed to the link, not the resolver.

### INCIDENT-CARD blasted-nginx-tls-pair-mismatch (2026-09-27)
- WHAT: thebrick's blasted-nginx container (blasted.social front door) was in a restart loop since before the 09-27 host outage (restart churn visible >=09:29Z 09-27; loop continued after the 11:16:01 BST boot) — nginx exits 1 on `SSL_CTX_use_PrivateKey("/etc/nginx/ssl/server.key") failed ... key values mismatch`. On John's direct instruction (owner-approved, via Lilly event af8e9037), the loop was PAUSED at 2026-09-27 11:06:37 UTC: `docker update --restart=no blasted-nginx && docker stop blasted-nginx` — container now Exited (1), restart policy `no`; verified stable (no restart churn). It was not serving traffic while looping. BROKEN-ON-START until the TLS pair is reconciled.
- ROOT: the mounted TLS pair is mismatched — server.crt (mtime Sep 12 06:43 BST) is not the pair of server.key (mtime Jul 6 16:43 BST); modulus md5 crt 5853e320d04f30a503e091987da3f99b != key 07ca316da82af0fa5b85ce12ea2e79c6 (verified by Lilly from the Mac). Files: ~/blasted.social/nginx/ssl/ (mounted at /etc/nginx/ssl); conf ~/blasted.social/nginx/nginx.thebrick.conf.
- FIX: pause-only per instruction (above). Full fix pending: reconcile the pair — `openssl rsa -noout -modulus -in server.key | md5` must equal `openssl x509 -noout -modulus -in server.crt | md5` (regenerate/reissue whichever side is stale), then `docker start blasted-nginx` (or compose up), verify HTTPS, and restore the intended restart policy (`unless-stopped` was in force before the pause).
- CLASS: TLS key/cert mismatch as a silent start-failure loop — the service was down and thrashing with no monitor flagging it (found incidentally during host forensics), and each restart retried a config that could never succeed.
- RULE: OPERATING RULE — when a service is caught in a hard start-failure loop (TLS key/cert mismatch, bad config), pause the loop first (`docker update --restart=no` + `docker stop`) and record the exact restore path where the owner looks (shared semantic fact + incident card + needs-john); reconcile key/cert pairs by modulus comparison before restarting, and restore the intended restart policy only after the service verifiably starts.
- WHERE: semantic_facts "SERVICE RECORD blasted-nginx" (shared, my-team) + this card.
- METRIC: restart loop stopped (policy no, Exited(1), stable at check); record findable by tags blasted-nginx/service-record/needs-john; functional impact zero (was already down).
