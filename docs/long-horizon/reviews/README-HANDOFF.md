# Katra Long Horizon Cognitive Control — handoff landing

Received from the operator, 19 September 2026. Reviewed by the loop director the same day.

**⚠️ This directory is deliberately OUTSIDE the git working tree. Do not commit it, do not
copy it into a repository, do not push it. See the constraint in the review.**

## What is here

```
README-HANDOFF.md                              ← you are here
REVIEW-long-horizon-cognitive-control.md       ← READ THIS FIRST (the loop director's independent review)
MANIFEST.sha256                                ← integrity hashes for every file

handoff/                                       ← the design package, as received
  README.md                                      package overview + recommended build order
  Katra_Long_Horizon_Cognitive_Control_Scoping_Brief.docx   formatted approval brief
  docs/01-scoping-brief.md                       scope, baseline, target architecture
  docs/02-data-model-and-interfaces.md           collections, schemas, 13 MCP tools, events
  docs/03-workflows.md                           10 end-to-end operating workflows
  docs/04-implementation-plan.md                 phases 0-8, ~35 backlog items
  docs/05-test-and-evaluation-plan.md            12 invariants, 8 e2e scenarios, metrics
  docs/06-operations-security-and-rollout.md     authority, privacy, failure modes, rollout
  docs/07-skill-catalog.md                       the 9 seed skills + promotion policy
  schemas/*.schema.json                          6 JSON Schema (draft 2020-12) contracts
  skills/*/SKILL.md                              9 seed procedural skills

source/                                        ← originals for provenance
  Katra_Long_Horizon_Cognitive_Control_Handoff.zip
  Katra_Long_Horizon_Cognitive_Control_Scoping_Brief.docx

```

## Reading order

1. **`REVIEW-long-horizon-cognitive-control.md`** — the review. It verifies every load-bearing
   claim against the repo at `35f61fb` and lists what must change before implementation.
2. `handoff/README.md` — the design's own 1-page overview.
3. `handoff/docs/01-scoping-brief.md` — the argument.
4. `handoff/docs/04-implementation-plan.md` — the phases.

## Verify integrity

```bash
cd ~/katra-long-horizon && shasum -a 256 -c MANIFEST.sha256
```

28 files. The review is `19d4656c54dc449a479fa3459b3a26f2d72bbb48fbf6340f314fcfa44a9ef09a`.

## The constraint

The target repository `github.com/kolegadev/Katra-Agentic-Memory` is **public**. This design
describes a capability step whose publication/monetisation decision has **not** been made.

- Work on a **local branch that is never pushed**.
- A `pre-push` hook in the repo refuses to push that branch — the constraint is mechanical,
  not a matter of discipline.
- Do not add design docs to `docs/` on a pushed line of history.
- Publication is a deliberate act requiring the operator's explicit approval.
