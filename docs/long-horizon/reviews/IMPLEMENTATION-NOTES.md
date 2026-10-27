# Long Horizon Cognitive Control — implementation notes (Satori, 2026-09-19)

Local-testing implementation on thebrick, branch `feat/cognitive-control-local` in
`~/Katra-Agentic-Memory` — **never pushed** (pre-push hook blocks it mechanically).

## Decisions (ADR-style, per review immediate actions)

1. **Skill versioning** (§3.1): `version?: string` added to `KatraSkill`, `SkillSearchResult`,
   and `SkillFeedbackRecord`; loader threads it; feedback records `skill_version`. Live `main`
   bug fixed: `confidence: Number(metadata.confidence) ?? 0.5` → `Number.isFinite(...)` guard.
2. **Seed skill frontmatter** (§3.2): all 9 skills in `~/katra-long-horizon/handoff/skills/*/SKILL.md`
   now carry `title`, 4–6 real `triggers`, and `confidence: 0.5` (activation Path B unlocked).
3. **Schema minor-version policy** (§4.5): root `additionalProperties` relaxed to `true` on all
   six contracts (honours "tolerate additive minor fields"); nested structural strictness kept.
   Cross-file `$ref`s resolve via a six-schema Ajv registry.
4. **Retention/compaction** (§4.4): `mission_events` TTL 90d, `cognitive_batons` TTL 7d via
   `_expires_at` (audit metadata lives in events); deltas/ledger/version snapshots retained;
   `mission_state_versions` compacted to last 30 at each checkpoint.
5. **Authority** (§3.4): first cut in TS at the tool boundary — untrusted callers pinned to
   their own identity (payload `owner_id`/`author_id` ignored) and capped at authority class B;
   trusted callers may declare A/B/C explicitly. The Python `authority_matrix.py` remains an
   advisory hint. Full TS port + explicit-declaration-wins policy: deferred (see below).
6. **MCP caller rules** (§4.1): implemented as above; visibility = owner OR shared-scope OR trusted.
7. **Event rail** (§3.5): durable `mission_events` outbox in Mongo (authoritative) + advisory
   Redis publish on `katra:mission-events`; no consumer offsets yet (deferred).
8. **Adapter** (§4.3): `adaptLegacyMission`/`adoptLegacyMission` — mapping table in
   `server/src/services/mission-cognition/adapter.ts`; in-flight tasks become v1 objectives
   (ids preserved); idempotent adoption; `authority_class` defaults to B until owner declares.

## Implemented (local branch)

- `server/src/types/cognitive-control.ts` — domain types.
- `server/src/services/mission-cognition/` — schema registry (Ajv 2020 + ajv-formats),
  collections/indexes (9 collections), mission-state service (create/get/checkpoint/
  rebuild-from-checkpoint, monotonic versions, compaction), state-delta service
  (validate → dedupe → version-check → merge/conflict → outbox-style apply → event +
  stale-baton invalidation), epistemic ledger (append/supersede/confidence-history/
  dependency closure with cycle detection), baton service (compile/issue/get/invalidate,
  blindness withholding, secret-pattern rejection), event rail, legacy adapter, facade
  with `COGNITIVE_CONTROL_ENABLED=off|read|write`.
- MCP tools (9, Phase 1–2 set) wired into `mcp-server.ts` behind the feature flag:
  `create_mission_v2`, `get_mission_state`, `submit_state_delta`, `list_state_deltas`,
  `query_epistemic_ledger`, `compile_cognitive_baton`, `get_cognitive_baton`,
  `checkpoint_mission`, `resume_mission`.
- `ajv` added to `server/package.json` dependencies (^8.17.1; already present in
  node_modules at 8.20.0 — lockfile refresh pending a writable checkout).

## Verification (thebrick, container node v20)

- `npx tsc --noEmit` clean.
- `node esbuild.config.mjs` builds 108 files cleanly.
- New tests: `tests/unit/mission-cognition.test.ts` (12) + `tests/unit/mission-cognition-mcp.test.ts`
  (5) + shared `tests/helpers/fake-mongo.ts` — all pass.
- Full unit suite: **44 files, 702 passed, 5 skipped, 0 failed** (vs 42/674+5 before).
- Covered invariants: monotonic versions, exactly-once idempotency, stale-base conflict
  (neither proposal dropped), caller-bound authorship, immutable confidence history,
  dependency cycles, blind batons withhold incumbent material, secret rejection,
  stale-baton revocation, deterministic rebuild, adapter mapping, untrusted authority cap.

## Deferred (per review §5 sequencing — do not build yet)

- Phase 3: installing the 9 skills into `server/src/skills/` (frontmatter already fixed),
  kernel activation heuristics, version pinning, outcome instrumentation.
- Phase 2 tail: wake-ritual extension + compression pre-hook.
- Phase 4–8: scheduler (shadow mode), uncertainty engine/fan-out, activation gates,
  dashboard, evaluation.
- Formal TS authority matrix + shared config with `scripts/python/authority_matrix.py`.
- Durable outbox consumer offsets / repair worker.
- Live-server activation: katra-server image rebuild + `COGNITIVE_CONTROL_ENABLED`
  env and restart remain John-gated. No production collection touched; the feature
  flag defaults to `off`.
