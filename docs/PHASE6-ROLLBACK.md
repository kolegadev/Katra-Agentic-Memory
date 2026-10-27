# Phase 6 — Rollback and Kill Switch Runbook

Branch `feat/cognitive-control-local` was created local-only; **its content is now public** — `feat/imagination-engine` (tip `048d060`) was pushed 2026-10-22 to `origin` (PUBLIC: kolegadev/Katra-Agentic-Memory) and `longhorizon` (PRIVATE: kolegadev/Long-Horizon), no PR. The pre-push guard was restored after that one publication; future pushes touching mission-cognition/authority/Phase-6 are gated again. Read "local only" as the branch's origin, not the content's current state.

## Immediate control (no rebuild, no code change) — contract §4.10

**Kill switch (env + restart):**

```bash
# In the deployment directory (the .env that docker compose reads):
echo 'COGNITIVE_ACTIVATION_KILL_SWITCH=1' >> .env
docker compose up -d --force-recreate --wait server
```

`COGNITIVE_ACTIVATION_KILL_SWITCH=1` forces `COGNITIVE_SCHEDULER_MODE` to `off`
regardless of every other flag — verified in unit tests (`cognitive-activation.test.ts`,
"kill switch forces off regardless of every other flag") and in the running container
against `/app/build` (Phase 6 deployment acceptance, the §4.18 section below).

**Runtime toggle (no rebuild, no restart):**

```
MCP tool: set_scheduler_mode { mode: "off", reason: "..." }
```

Every downward transition (`allocate_internal → recommend → shadow → off`) is
reachable and recorded in the activation ledger with who/when/evidence
(contract §4.19-20, tested in `cognitive-activation.test.ts`).

## One-command code rollback — contract §4.11

The tag `phase5-green` is the pre-Phase-6 build: the Phase 5 graded green ref
`f797550` plus the criterion-2 transitivity carry-forward fix (`5292da3`).
It contains **no Phase 6 changes** — in particular its
`server/src/services/processing/autonomous-executive.ts` is the untouched
pre-Phase-6 allocator.

```bash
cd ~/Katra-Agentic-Memory
git checkout phase5-green          # working tree = pre-Phase-6 code
# then deploy that ref (same path the deployment docs use):
docker compose up -d --build --wait server
```

## Tag verification (done before relying on the tag — §4.11)

```
$ git rev-parse phase5-green 5292da3 f797550
5292da34d27c6119bb6f6fc9214fcec20f237960
5292da34d27c6119bb6f6fc9214fcec20f237960
f797550b581a44b91cbfe3474bafd550967c1b0f

$ git show phase5-green:server/src/services/processing/autonomous-executive.ts | sha256sum
b66a83d5acca83e4cd05fcec852e86835b33ac1d2733fab21aeedbc54cc20ac32  -
$ git show 5292da3:server/src/services/processing/autonomous-executive.ts | sha256sum
b66a83d5acca83e4cd05fcec852e86835b33ac1d2733fab21aeedbc54cc20ac32  -
```

The tag resolves to exactly `5292da3` (parent of the Phase 6 commits) and the
tagged tree's allocator is byte-identical to the pre-Phase-6 allocator — the
tag contains what its name claims.

## Off-state equivalence (why rollback is provable) — §4.16

`server/tests/unit/executive-allocation-offstate.test.ts` pins the allocator's
allocation decision for a fixed input fixture to the pre-Phase-6 byte baseline
(captured from `5292da3` BEFORE the allocator change). With the flag `off` the
allocator output is byte-identical to that baseline; the same test exercises
the Phase-6 influence hook in off state and confirms it returns the allocation
unchanged, byte for byte.

## Deployment acceptance — contract §4.18 (through the image, not the mount)

Phase 6 was accepted against the image's own code path, not the read-only
`/repos/katra-server` source mount (the discipline forced by the 2026-09-19
rebuild incident, where the running container once served a baked pre-branch
image). Container `katra-server`, rebuilt from
`feat/cognitive-control-local` @ `217a33a`, flags at deployment default `off`:

```bash
# Phase-6 modules present in /app/build (Phase-5 baseline was 24):
$ docker exec katra-server sh -c 'ls /app/build/services/mission-cognition | wc -l'
27                     # + scheduler-mode.js, activation-service.js, activation-bridge.js

# The additive hook is present in the image's own allocator build:
$ docker exec katra-server grep -c 'maybeInfluenceAllocation' \
    /app/build/services/processing/autonomous-executive.js
2                      # method + call site

# Criterion 10 (kill switch) confirmed inside the running container against
# /app/build — NOT the mount:
$ docker exec katra-server node --input-type=module -e "…import scheduler-mode.js…"
default/off -> off
shadow -> shadow
recommend -> recommend
allocate_internal -> allocate_internal
allocate_gated (unimplemented) -> off
unknown value -> off
kill switch beats allocate_internal -> off
```

Independently verified by the Phase-6 verifier (2026-09-20): tool surface
through the real MCP entrypoint **83 tools off → 114 on** with the cognitive
plane enabled, and **7/7 Phase-6 modules byte-identical** in the image.
Nothing above `off` is active on the running instance — activation requires
the evidence gate, per-mission opt-in, and an explicit mode transition, each
of which is recorded in the activation ledger and reversible per this runbook.
