# Independent Review — Katra Long Horizon Cognitive Control Handoff v0.1

**Reviewer:** Lilly (Kolega Code), on the Mac checkout
**Date:** 19 September 2026
**Scope:** the handoff package as received — README, docs 01–07, 6 JSON Schemas, 9 seed SKILL.md
**Method:** full read, then every load-bearing claim checked against the actual repository at
commit `35f61fb` (mac `~/.katra/src`, identical to thebrick `~/Katra-Agentic-Memory` and `origin/main`).

**Verdict: the design is sound and unusually well-argued. It is also mislabelled in a few
places about what already exists, and it depends on at least one runtime capability that
does not exist. None of that is fatal. All of it is cheap to fix now and expensive to
discover mid-Phase-3.**

---

## 1. Summary

The package specifies five runtime primitives (Mission State, Epistemic Ledger, Cognitive
Baton, State Delta, Cognitive Scheduler) plus nine seed skills, delivered in eight phases.
The architectural reasoning is good: it correctly separates identity / mission / procedural
learning loops, it refuses to average away contradiction, and it treats uncertainty as a
first-class addressable object rather than a confidence number. The "avoid" lists in
`explore-and-falsify` and `breaking-hypothesis-lock-in` name the real failure modes.

The problems are not in the design. They are in the **gap between what the design assumes
already exists and what is actually in the tree.** Five substantive findings follow, ordered
by how much they cost to fix later.

---

## 2. Claims verified correct

Checked against `35f61fb`. These hold and can be relied on:

| Claim | Status | Evidence |
|---|---|---|
| 66 MCP tools | ✅ exact | `docs/MCP-TOOLS.md` states "exposes **66 tools**" |
| Basic missions + goal decomposition | ✅ | `create_mission`, `get_mission`, `list_missions`, `update_mission_task`, `decompose_goal` |
| `missions` collection in use | ✅ | referenced in `mcp-server.ts`, `personality-profiles.ts`, `memory-integrity.ts` |
| Procedural skill engine w/ feedback + refinement | ✅ | `skill-loader-service.ts`, `skill-refinement-service.ts`, `skill-synthesis-service.ts` |
| Vault-backed capability layer | ✅ | `server/src/services/vault/` |
| Object storage for large artifacts | ✅ | `s3-asset-service.ts` (MinIO, 9 refs) |
| Redis pub/sub exists | ⚠️ partially — see 3.5 | 6 `publish(` call sites |
| Authority classes A / B / C | ✅ exists — but Python — see 3.4 | `scripts/python/authority_matrix.py` |
| Wake ritual | ✅ | `katra-wake-ritual/SKILL.md` |
| No naming collisions for the 13 proposed tools | ✅ | all 13 names return 0 hits in `server/src` |

The proposed MCP tool names (`create_mission_v2`, `get_mission_state`, `submit_state_delta`,
`compile_cognitive_baton`, …) are all free. Nothing needs renaming.

---

## 3. Findings

### 3.1 — `version` is not a field the runtime understands (blocks Phase 3)

**The seed skills declare `version: 0.1.0`. Nothing reads it.**

```ts
// server/src/types/memory.ts:369
export interface KatraSkill {
  name: string; title: string; category: SkillCategory; description: string;
  status: SkillStatus; observation_count: number; success_count: number;
  failure_count: number; confidence: number; triggers: string[];
  created_at: Date; last_used_at?: Date; last_refined_at?: Date;
  source: 'auto-distilled' | 'manual-request';
}                                   // ← no `version` field anywhere
```

`parseFrontmatter()` will capture `metadata.version`, but `loadSkillFile()` never reads it.
It is silently discarded at load. Confirmed: `version` appears in **none** of the 9 currently
installed skills either — this is not an existing convention the package is following, it is a
new field the package is introducing into a loader that ignores it.

This matters because the design makes skill versioning load-bearing in at least six places:

- baton field `skill_versions` (schema `cognitive-baton.schema.json`)
- delta field `skills_used` (schema `state-delta.schema.json`)
- rollout flag `SKILL_VERSION_POLICY=pinned|candidate_canary|latest_stable`
- `CCP-102` "Pin versions by mission"
- `CCP-105` "Prevent active-mission silent skill mutation"
- Workflow 8, steps 1 and 8

**So: skill versioning is a new subsystem, not an increment.** `SKILL_VERSION_POLICY=pinned`
cannot be implemented until `version` is threaded through `KatraSkill`, the loader, the
`SkillSearchResult` surface, `record_skill_outcome`, and the refinement path.

*Good news:* `updateSkillFrontmatter()` re-reads metadata, applies updates, and rewrites **all**
keys — so an unknown `version:` key round-trips safely through refinement and will not be
erased. The field is inert, not destructive.

### 3.2 — All 9 seed skills are missing the frontmatter keys search actually uses (blocks Phase 3)

The 9 installed skills all carry `title`, `triggers`, and `confidence`. **All 9 seed skills
omit all three.** Verified mechanically:

```
breaking-hypothesis-lock-in      title=0 triggers=0 confidence=0 version=1
cognitive-baton                  title=0 triggers=0 confidence=0 version=1
context-transition               title=0 triggers=0 confidence=0 version=1
distributed-cognition            title=0 triggers=0 confidence=0 version=1
epistemic-ledger                 title=0 triggers=0 confidence=0 version=1
explore-and-falsify              title=0 triggers=0 confidence=0 version=1
long-horizon-mission             title=0 triggers=0 confidence=0 version=1
mission-replanning               title=0 triggers=0 confidence=0 version=1
mission-state-management         title=0 triggers=0 confidence=0 version=1
```

Why this is not cosmetic — skill activation is a weighted merge of three paths:

```ts
const WEIGHT_A = 0.5;   // TF-IDF over name/title/description
const WEIGHT_B = 0.3;   // trigger-condition matching
const WEIGHT_C = 0.2;   // embeddings
```

and `matchTriggers()` is gated:

```ts
if (matchedTriggers > 0 && skill.triggers.length > 0) { ... }
```

With `triggers: []` the condition is **always false**, so the seed skills cannot score on
Path B at all. That is a **hard, structural 30% activation deficit against every existing
skill**, before any competition begins. `title` falls back to `name`, so title tokens
(weighted 2×) merely duplicate name tokens instead of adding descriptive vocabulary.

This directly attacks the Phase 3 exit criterion — *"Complex multi-session tasks reliably
activate the router."* A router that cannot win the activation contest will not reliably
activate.

**Fix before installation:** add `title`, 3–6 real `triggers` per skill, and an explicit
`confidence` to each of the nine. Doc 07 already instructs that these be "validated against
Katra's current frontmatter parser" — this is that validation, and they do not currently pass.

### 3.3 — Pre-existing bug: `confidence` silently becomes `NaN` (independent of this project)

```ts
// skill-loader-service.ts:232
confidence: Number(metadata.confidence) ?? 0.5,
```

`Number(undefined)` is `NaN`. `NaN ?? 0.5` is `NaN` — nullish coalescing catches only
`null`/`undefined`, never `NaN`. **Any skill without an explicit `confidence` field loads as
`NaN`, not the intended `0.5`.**

Consequences:

- `SkillSearchResult.confidence` is `NaN`, which JSON/BSON serialises to `null` — so MCP
  consumers see `confidence: null` rather than a default.
- The first `record_skill_outcome` persists `confidence_before: NaN` into the feedback record.
- The auto-challenge guard `if (skill.confidence < 0.4 && …)` is `false` for `NaN`, so it can
  never fire from a `NaN` state.

It self-heals after the first feedback because confidence is then recomputed from counts — but
the initial records are wrong and the default is not what the code intends.

**Correct fix:** `Number.isFinite(Number(metadata.confidence)) ? Number(metadata.confidence) : 0.5`
(note `|| 0.5` would be wrong — it would turn a legitimate `0` into `0.5`).

This is a genuine latent bug in `main` today and is worth fixing on its own merits. It becomes
live the moment the nine skills land, because all nine omit the field.

### 3.4 — The authority model is Python, and the design puts it in TypeScript

Doc 01 lists "an authority matrix that distinguishes autonomous, gated, and cautious actions"
under **Confirmed current baseline**, and doc 06 says "reuse the existing authority matrix".
It does exist — but not where the design will look for it:

```
scripts/python/authority_matrix.py      (137 lines, Python)
  ScopeRule(name, patterns[], autonomy, mandatory_action, failure_condition)
  A AUTONOMOUS — katra, memory, docker, salience, embedding, …
  B GATED      — user projects, github.com/kolegadev, …
  C CAUTIOUS   — launchd, systemd, nginx, ssh, sudo, …
```

The classes map **1:1** onto the design's `A|B|C` and `autonomous|gated|cautious`. That part is
sound. Two things need deciding in Phase 0:

1. **The TS server has zero concept of it.** `grep -i authority server/src --include=*.ts`
   returns **0 hits**. The design puts `authority_class` on missions, work items, and batons,
   and `approval` on capabilities — all of which live server-side. So enforcement must be
   reimplemented or bridged in TypeScript. **Two independent authority implementations is a
   safety hazard**: they will diverge, and whichever is consulted last becomes the real gate.

2. **The current classifier infers scope from free-text keyword patterns.** That is fine for
   a heuristic nudge and far too weak to be a security boundary. If authority classification is
   the last gate before an external effect, mission `authority_class` should be **explicitly
   declared by the mission owner and enforced server-side**, with the Python matrix reduced to
   an advisory hint rather than the authority of record.

**Recommendation:** single source of truth in TypeScript; have the Python tools call into it or
share one config file; make explicit declaration override inference.

### 3.5 — "The existing shared event rail" is narrower than the design implies

Doc 02 says "Publish typed events on the existing shared event rail" and specifies 18 event
types across `mission.*`, `delta.*`, `ledger.*`, `uncertainty.*`, `decision.*`, `baton.*`,
`work.*`, `scheduler.*`.

What exists is Redis pub/sub — 6 `publish(` call sites, concretely used by
`consolidation-output-bus.ts` as a **consolidation output bus**. That is a real mechanism but
not a general domain event rail, and it has no durability story.

Phase 1's key rule already anticipates the hard part ("Use transactions where supported … If
transactions are unavailable, use an outbox and a deterministic repair worker"). Classify the
event rail as **closer to `new` than `extend-existing`**, and budget the durable outbox and
consumer offsets explicitly rather than treating them as reuse.

---

## 4. Gaps the design does not address

**4.1 — Who enforces authority for MCP callers?**
The A/B/C model governs the *autonomous loop*. But the 13 new tools will be called by external
agents over MCP, and the repo already distinguishes **trusted** callers (loopback, admin key)
from **untrusted** callers (client keys pinned to their own identity — see `docs/MCP-TOOLS.md`).
The design never says whether an untrusted caller may create work items, submit deltas, or
declare `authority_class: A`. This is a real hole and it is a security boundary. Specify it in
Phase 0.

**4.2 — Cost accounting is assumed but not specified.**
The priority formula divides by `cognitive_cost`, suitability subtracts a workload penalty, and
Phase 6 wants budget limits and circuit breakers. Katra currently records **events, not token or
dollar costs**. Either add cost capture at the provider boundary or the scheduler ranks on
invented numbers. Worth noting that Jev is now available at ~$0.0000236/call for bounded
decisions — a plausible cheap engine for some scheduling sub-decisions, though it cannot be
Katra's chat LLM.

**4.3 — No concrete bridge from existing `missions` to `mission_states`.**
"Retain current mission tools during migration … adapt their output into Mission State where
safe." The existing object is a goal + task tree; the new one is a versioned operational model.
No adapter is specified. Satori currently has **live missions** — they must not become
second-class citizens. Phase 1 needs an explicit mapping table, including what happens to
in-flight tasks when a mission gains a version.

**4.4 — No retention or compaction policy.**
Nine append-heavy collections, no TTL, no GC. `epistemic_entries` and `state_deltas` grow
without bound, and `mission_state_versions` is described as "snapshots **or compacted**
checkpoints" without saying which or when. This instance already holds **756,788 events**.
Decide retention, compaction cadence, and archive rules in Phase 1 — retrofitting them later is
painful.

**4.5 — The schemas contradict their own versioning policy.**
Doc 02: "Reject unknown major versions; **tolerate additive minor fields**." Every schema sets
`"additionalProperties": false`. An additive minor field will therefore **fail validation on
read** of already-persisted documents. Either relax `additionalProperties` to `true` on the
versioned documents, or drop the "tolerate additive minor" claim and commit to strict
versioning with migrations. As written, the stated policy cannot be honoured.

*Also minor:* `cognitive-baton.schema.json` and `state-delta.schema.json` use cross-file `$ref`
(`mission-state.schema.json#/$defs/capability`, `epistemic-entry.schema.json`). That is legal
but requires a resolver/registry configured with all six schemas by `$id` — worth an explicit
note so it does not surface as a confusing validation failure.

---

## 5. Scope realism

Measured against the actual tree:

| | |
|---|---|
| `server/src` | 97 TypeScript files, ≈47,500 lines |
| test files | 49 |
| docs | 34 |
| installed skills | 9 |

The proposal adds: **9 collections, 13 MCP tools, 8 REST resource groups, 9 skills, 8 phases,
~35 backlog items, 12 invariants, 8 end-to-end scenarios.**

Honest assessment: this is a **program of work on the order of 30–50% of the existing server**,
not a feature. Phase 1 alone — five collections plus version history, checkpointing, optimistic
concurrency, idempotency, a typed delta merge with conflict routing, event emission, and audit —
is a substantial service in its own right.

**Recommended sequencing.** Do not attempt phases 0–8 serially. The value is front-loaded:

1. **Phase 0** + the §3.1/§3.2/§3.3 prerequisites (small, mechanical, unblocks everything).
2. **Phases 1–2 only** — Mission State, ledger, baton, checkpoint/resume.
3. Run **one real mission** end-to-end through a genuine context clear. That single test proves
   or kills the core claim: that mission continuity survives without chat replay.
4. *Then* decide on the scheduler and uncertainty engine.

The scheduler (Phase 4) and uncertainty engine (Phase 5) are where the cost and the risk sit,
and neither is required to validate the central idea. Scheduling is also the part most likely to
be wrong in ways that are hard to attribute — so it should come after the state layer is trusted,
and it should stay in shadow mode for a long time.

---

## 6. What is genuinely good here

Worth preserving deliberately, because these are the parts that will still be right in a year:

- **The three-loop separation** (identity / mission / procedural learning) with different
  records and cadences for the same event. This prevents a real class of bug.
- **Contradiction is never averaged away** — it becomes an object with consequences. Most
  agent-memory systems get this wrong.
- **Blind exploration with a recorded withholding policy.** The blindness object in the baton
  schema is auditable rather than aspirational.
- **Confidence as history, not a scalar.** `confidence_history[]` with prior/next/reason/actor
  is exactly right.
- **"A task marked complete is not proof that the mission outcome was achieved."** This is the
  single most valuable sentence in the package and should survive every future revision.
- **The anti-pattern lists.** `explore-and-falsify`'s "asking agents to be creative after showing
  them the favored answer" and `breaking-hypothesis-lock-in`'s "expose blind workers to the
  favored answer through filenames, labels, summaries, or examples" name failure modes that are
  invisible until they have already corrupted a result.

---

## 7. Recommended immediate actions

| # | Action | Effort | Blocks |
|---|---|---|---|
| 1 | Add `title`, `triggers`, explicit `confidence` to all 9 seed skills | small | Phase 3 |
| 2 | Fix `confidence: Number(x) ?? 0.5` → `Number.isFinite(...)` in the loader | trivial | — (also fixes a live bug) |
| 3 | Add `version` to `KatraSkill`, loader, search result, feedback path | medium | Phase 3, `SKILL_VERSION_POLICY` |
| 4 | Decide the single source of truth for authority; plan the TS port | medium | Phase 0 exit, Phase 6 |
| 5 | Specify MCP-caller authority rules against trusted/untrusted callers | medium | Phase 0 exit |
| 6 | Resolve the `additionalProperties` vs minor-version contradiction | small | Phase 1 |
| 7 | Add retention/compaction policy for the 9 new collections | small | Phase 1 |
| 8 | Specify the `missions` → `mission_states` adapter | medium | Phase 1 |

---

## 8. Handling constraint — do not publish

John's instruction, and the reason this document is filed outside the repository:

> **This work must NOT reach the public GitHub remote.**
> `github.com/kolegadev/Katra-Agentic-Memory` is public. The long-horizon cognitive control
> layer is a capability step worth considering for monetisation, and that decision has not
> been made.

Accordingly:

- **This review and the whole handoff package live outside the git working tree**, at
  `~/katra-long-horizon/` on thebrick. They cannot be committed by accident.
- **Implementation happens on a local branch that is never pushed.** A `pre-push` hook refuses
  to push it, so the constraint is enforced mechanically rather than by discipline.
- **Do not add design docs to `docs/`** in a pushed state. Doc 06's "documentation updates
  required in the repository" applies to the eventual private/paid form, not to `main` today.
- If a decision is later made to publish, that is a deliberate act requiring John's explicit
  approval — not a side-effect of a routine push.

---

*End of review. Prepared by Lilly. All repository claims are reproducible against `35f61fb`;
the verification commands are recorded in the session log.*
