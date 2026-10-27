# Gap-Closure & Delivery Plan — Katra Long Horizon Cognitive Control

**Joint plan: the loop director (Mac) + the generator**
**Opened:** 19 September 2026
**Branch:** `feat/cognitive-control-local` — **local only, never pushed**
**Review of record:** `~/katra-long-horizon/REVIEW-long-horizon-cognitive-control.md`

---

## 0. Status: implementation is already underway and in good shape

the generator began before this plan was written. Verified state on thebrick:

- branch `feat/cognitive-control-local`, based on `main` @ `35f61fb`
- `server/src/services/mission-cognition/` — **2,314 lines** across 10 modules + 6 schemas
- 3 test files (`mission-cognition.test.ts`, `mission-cognition-mcp.test.ts`, `fake-mongo.ts` helper)
- 4 existing files modified: `mcp-server.ts`, `skill-loader-service.ts`, `types/memory.ts`, `package.json`

**The no-publish guard was extended on 19 Sep** — see §5. the generator's branch and file paths were
*not* covered by the first version of the hook (the work used `mission-cognition/`, the guard
matched `cognitive/`). Both rules now cover it, and this was tested against the real branch.

---

## 1. Review findings — closure status

| # | Finding | Owner | Status |
|---|---|---|---|
| §3.1 | `version` missing from `KatraSkill`; skill versioning doesn't exist | the generator | ✅ **closed** — `version?: string` added to `KatraSkill`, `SkillFeedbackRecord`, `SkillSearchResult`; loader reads and surfaces it; `skill_version` persisted on feedback |
| §3.2 | 9 seed skills omit `title`, `triggers`, `confidence` (30% activation deficit) | **the loop director** | ⬜ **open — this plan** |
| §3.3 | `confidence: Number(x) ?? 0.5` → `NaN` | the generator | ✅ **closed** — `Number.isFinite(...)` guard, exactly as specified |
| §3.4 | Authority model is Python; server has no concept of it | **the loop director** | ⬜ **open — this plan** |
| §3.5 | Event rail narrower than claimed; no durability | the generator | ✅ **closed** — durable Mongo outbox (`mission_events`) + advisory best-effort Redis |
| §4.3 | No `missions` → `mission_states` adapter | the generator | ✅ **closed** — `adapter.ts` (`adoptLegacyMission`) |
| §4.4 | No retention / compaction policy | the generator | ✅ **closed** — TTL 90d events, 7d batons, keep last 30 state versions |
| §4.5 | Schemas say `additionalProperties:false` but promise additive minor fields | **the loop director** | ⬜ **open — this plan** |
| §4.1 | MCP-caller authority rules unspecified | **the loop director** | ⬜ **open — this plan** |
| §4.2 | Scheduler has no cost data to divide by | deferred | ⏸ **deferred with Phase 4** (correct) |

the generator independently resolved two findings I raised as design gaps (§4.3, §4.4) without being
asked, and deferred the scheduler/uncertainty tools exactly as recommended — 9 of 13 MCP tools
are registered, and the 4 omitted are precisely the scheduler and uncertainty surface.

---

## 2. Ownership split — disjoint file sets, no collisions

The rule is simple: **two agents must never edit the same file.**

### the generator owns
```
server/src/services/mission-cognition/**     (all modules + schemas)
server/src/types/cognitive-control.ts
server/src/mcp-server.ts                     (cognitive tool wiring)
server/tests/**                              (mission-cognition tests)
server/src/services/memory/skill-loader-service.ts
server/src/types/memory.ts
```

### the loop director owns
```
server/src/skills/<category>/<name>/SKILL.md   (the 9 seed skills)
server/src/services/authority/**               (new — TS authority service)
server/src/services/mission-cognition/schemas/*.schema.json
    ↑ SHARED — the loop director will NOT touch these without the generator's agreement; see §3.3
~/katra-long-horizon/**                        (plan, review, verification reports)
```

**Anything in the generator's set is the generator's call.** the loop director reviews and verifies but does not edit.
If the loop director needs a change in the generator's files, it is raised as a finding, not a commit.

---

## 3. the loop director's workstreams

### 3.1 Seed skills — fix frontmatter, then install  *(closes §3.2)*

All 9 seed skills must gain `title`, `triggers`, and `confidence` before installation. Without
`triggers` they can never score on the activation path worth `WEIGHT_B = 0.3`.

Convention taken from the 9 currently installed skills:
```yaml
name: <kebab-name>
title: <Human Readable Title>
category: operational|decision|troubleshooting
description: ...
status: candidate
version: 0.1.0
observation_count: 0
success_count: 0
failure_count: 0
confidence: 0.5
triggers:
  - <phrase>
  - <phrase>
```

Install to `server/src/skills/<category>/<name>/SKILL.md` — note the **category directory**
level, which the package's flat `skills/<name>/` layout omits.

Activation manual during development, per doc 07.

### 3.2 Authority service — TS port + explicit declaration  *(closes §3.4, §4.1)*

Port `scripts/python/authority_matrix.py` (137 lines, A/B/C = AUTONOMOUS/GATED/CAUTIOUS) into
the TypeScript server as the **single source of truth**.

Design decisions to implement:
- **Explicit declaration beats inference.** A mission's `authority_class` is declared by its
  owner and enforced server-side. The Python keyword matcher becomes an advisory hint only —
  it is too weak to be the last gate before an external effect.
- **One implementation.** The Python tools should read the same canonical config (or call the
  TS service) rather than keeping a parallel matrix. Two matrices will diverge.
- **MCP caller rules** (§4.1): resolve caller identity from authenticated context — never
  payload `user_id`. Untrusted client keys are pinned to their own identity and **cannot**
  declare `authority_class: A`. Trusted callers (loopback, admin) may act for any identity.
  Existing trusted/untrusted semantics are documented in `docs/MCP-TOOLS.md` and must be reused,
  not reinvented.

### 3.3 Schema version policy  *(closes §4.5)* — coordinate with the generator

The six schemas set `additionalProperties: false`, yet doc 02 promises to "tolerate additive
minor fields". An additive minor field would fail validation on read of persisted documents.

Two honest options:
1. Relax `additionalProperties` on the versioned documents and enforce strictness per-field.
2. Drop the "tolerate additive minor" claim and commit to strict versioning + migrations.

**This touches the generator's files**, so it is raised as a finding and implemented by the generator (or by
the loop director only with explicit agreement). Recommendation: option 2 for the three documents that are
append-only audit records (`state_deltas`, `epistemic_entries`, `mission_state_versions`) where
strictness is a feature; option 1 for the mutable projection documents.

### 3.4 Independent verification  *(ongoing)*

the loop director verifies the generator's work against the task contract, not against the generator's own claims:
- run `npm run typecheck` and `npm run build` after the generator's changes land
- run the mission-cognition test suites and report actual pass/fail
- confirm the `COGNITIVE_CONTROL_ENABLED=off` path exposes **no** new MCP tools
- confirm secret-boundary invariants: no credential value can reach a baton, ledger, delta, or event
- reproduce at least one end-to-end mission lifecycle against a real Mongo instance

---

## 4. Verification gates (do not skip)

Per doc 05's promotion gates, adapted to what is actually buildable now:

- [ ] `npm run typecheck` exit 0
- [ ] `npm run build` clean
- [ ] mission-cognition unit + MCP tests pass
- [ ] with the flag `off`: tool count unchanged at 66
- [ ] with the flag `read`: read tools available, writes rejected
- [ ] delta idempotency: same `idempotency_key` twice → one accepted delta
- [ ] optimistic concurrency: two deltas on the same base version → conflict routed, not silently overwritten
- [ ] state rebuild: replay accepted deltas from a checkpoint → identical Mission State
- [ ] blind baton contains no incumbent conclusion or rationale (fixture test)
- [ ] no secret value in any serialized baton / delta / ledger / event / log

**The single decisive test** — and the reason to stop after Phase 2:

> Create a mission, accept two deltas, assign work, checkpoint, **clear the agent context
> completely**, then resume. The resumed agent must identify mission version, ownership,
> changed state, active uncertainty, and next action **without transcript replay**.

If that passes, the core idea is proven. If it fails, no amount of scheduler work fixes it.

---

## 5. The no-publish constraint — unchanged and now stronger

`github.com/kolegadev/Katra-Agentic-Memory` is **public**. the operator has not decided on publication
or monetisation. Nothing from this work may be pushed.

**Guard v2** installed at `~/Katra-Agentic-Memory/.git/hooks/pre-push` (v1 backed up beside it):

- blocks branch names matching `local/`, `*cognitive*`, `*mission-cognition*`, `*long-horizon*`
- blocks committed paths under `server/src/services/{cognitive,mission-cognition}/`,
  `server/src/types/cognitive-control*`, `server/tests/*{mission-cognition,cognitive-control}*`,
  the six named design docs, and the six schema files
- **allows** ordinary pushes so unrelated work is unaffected

Tested on 19 Sep: `feat/cognitive-control-local` → **blocked**; the 20 files the generator created →
**19 matched** (the one miss is `tests/helpers/fake-mongo.ts`, generic test infrastructure,
deliberately unprotected to avoid false positives); `main` → allowed.

**To publish, the operator removes the hook by hand.** Neither agent can grant that approval, and
neither should try.

---

## 6. Sequencing — restated

The design proposes 8 serial phases. Against a 97-file / 47.5k-line server, that is a program
on the order of 30–50% of the existing codebase. The value is front-loaded:

1. **Phase 0 + prerequisites** — §3.2, §3.3, §3.4 above. *(in progress)*
2. **Phases 1–2** — Mission State, ledger, baton, checkpoint/resume. *(largely built)*
3. **One real mission through a genuine context clear.** *(the decisive test)*
4. **Then decide** on the scheduler (Phase 4) and uncertainty engine (Phase 5).

The scheduler and uncertainty engine carry the cost and the risk, and neither is required to
validate the central claim. Scheduling errors are also the hardest to attribute, so they should
follow, not precede, a trusted state layer — and stay in shadow mode for a long time.

---

## 7. Open decisions for the operator

1. **Publication/monetisation** — nothing is pushed until he decides.
2. **Schema strictness** (§3.3) — strict + migrations, or relaxed + additive? Recommendation in §3.3.
3. **Authority enforcement point** (§3.2) — confirm the server-side TS service becomes the
   single source of truth, with the Python matrix demoted to advisory.

---

*Maintained jointly. the loop director updates §1/§3, the generator updates implementation status.*
