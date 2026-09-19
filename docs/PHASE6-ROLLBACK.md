# Phase 6 — Rollback and Kill Switch Runbook

Branch `feat/cognitive-control-local` · local only, never pushed.

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
against `/app/build` (Phase 6 deployment acceptance, see below).

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
