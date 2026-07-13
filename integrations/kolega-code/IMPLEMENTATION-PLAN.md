# Implementation Plan — Personality-Weighted Memory Retrieval (v2)

**Component:** `integrations/kolega-code/kolega_katra_bridge` (prompt pre-injection pipeline)
**Author/date:** Architecture change, July 2026
**Status:** Implemented and unit-verified; ready for live A/B testing
**Patch:** `personality-retrieval.patch` (unified diff of all changes)

---

## 1. Problem Statement

The v1 `MemoryRetriever` ranked memories with a fixed source-weight table and the formula
`composite = SOURCE_WEIGHT × (1.0 + vector_score + recency_score)`. Two behavioural
misalignments with human memory followed from this:

**Misalignment 1 — retrieval was not cue-driven.** Human retrieval is dominated by the
current stimulus (cue-dependent retrieval); mood, recency, and self-schema modulate it
but rarely override it. In v1, a reflection with *zero* semantic relevance scored
`8.0 × 1.0 = 8.0`, while a perfectly relevant vector hit could reach at most
`2.0 × (1 + 1 + 1) = 6.0`. The agent effectively ruminated instead of responding to the
cue, and the most relevant memory to the current task was routinely crowded out.

**Misalignment 2 — forgetting was linear with a cliff.** The 30-day linear recency decay
meant a 31-day-old memory scored identically to a 3-year-old one. Human forgetting
curves are closer to power laws: steep early, long tail.

**The opportunity.** Because sleep consolidation reflects on whatever was salient in
context, the retrieval weights do not merely filter memory — they bias what future
reflections are *about*. Weighting is therefore a mechanism for cultivating durable,
self-reinforcing agent dispositions ("personality") instead of declaring temporary
personas in the system prompt. v2 makes the weights a first-class, named, tunable
configuration surface.

**Operational invariant (unchanged):** inter-agent messages (`agent_message`) must
always rank first. This is enforced in code and cannot be overridden by configuration.

---

## 2. Design Decisions (what changed and why)

### D1. Cue-driven composite scoring with a relevance multiplier
`composite = weight × (1 + k·vector_score + recency_score)`, k default **2.0**.
*Why:* weights now set the agent's *default disposition*, but a strongly relevant
memory of any type can break through — matching human cue-dependence and preserving
task competence under any personality skew. k is itself a personality parameter
(the `analyst` uses 3.0; `legacy` uses 1.0).

### D2. Power-law recency with per-personality half-life
`recency = 1 / (1 + age_days / half_life)`. Default half-life 14 days.
*Why:* removes the 30-day cliff; matches empirical forgetting curves. Half-life becomes
an expressive personality dimension: `sentinel` forgets steeply (4 days), `historian`
holds long (90 days).

### D3. Named personality profiles instead of a hard-coded weight table
New module `personality.py` with 10 profiles: `balanced` (default, human-baseline),
`legacy` (bit-for-bit reproduction of v1 ranking for A/B control), and 8 archetypes
(`scholar`, `pragmatist`, `strategist`, `historian`, `empath`, `analyst`, `sentinel`,
`dreamer`). Profiles carry weights plus all scoring parameters. Users can override
per-source weights and scoring on top of a named profile via `katra-hook.json`.
*Why:* archetypes form a rough basis set across four axes — interiority
(scholar↔pragmatist), feeling↔knowing (empath↔analyst), past↔present
(historian↔sentinel), and goal-directedness / associative looseness (strategist,
dreamer). Any custom disposition is expressible as an override blend.

### D4. Budget floors (guaranteed minimums)
Default floors: `working_memory` ≥ 10% and `vector_search` ≥ 15% of the token budget
(profiles may override; `sentinel` raises them). Floors are best-effort under the hard
budget: if the budget is already consumed, a floor cannot force an over-budget admit.
*Why:* human cognition does not let rumination fully evict working memory. Floors
guarantee an interiority-heavy profile can never render the agent non-functional at
tasks.

### D5. Homeostatic per-source cap
No single source (except `agent_message`) may exceed `max_single_source_pct` (default
40%) of the total budget.
*Why:* the consolidation feedback loop that produces a "philosopher" can also produce
the AI analog of a rumination spiral (`unresolved_threads` amplifying themselves).
The cap bounds runaway self-reinforcement while still allowing dominance.

### D6. Reflection split into three independently-weighted sources
`reflection` → `daily_reflection`, `philosophical_insights`, `unresolved_threads`.
The old umbrella name is still accepted in `sources` config and auto-expanded
(backwards compatible).
*Why:* with only 6 sources the personality space was cramped. The three reflection
outputs express very different dispositions (mood vs. principles vs. open tension) and
must be tunable separately — e.g. `strategist` wants unresolved threads high but
philosophy low.

### D7. Three new opt-in sources: `emotional_context`, `missions`, `knowledge_graph`
Backed by existing Katra MCP tools (`get_emotional_context`, `list_missions`,
`explore_graph`). Opt-in via the `sources` list; only fetched when the personality
weight ≥ `min_fetch_weight` (1.0), so low-weight sources cost no latency.
*Why:* these are the retrieval dimensions that make `empath` (feelings about entities),
`strategist` (goals/open loops), and `analyst` (structured knowledge) genuinely
distinct rather than re-shuffles of the same six feeds.
*Known limitation:* `get_emotional_context` requires an entity name; v2 uses a naive
extractor (quoted phrases + capitalised tokens from the prompt, max 2 probes). See
Phase 4 follow-ups.

### D8. Concurrent fetching
All source fetches now run via `asyncio.gather` with per-source fail-open.
*Why:* v1 was documented as "6 parallel sources" but was actually sequential awaits
inside an 8-second timeout. v2 adds up to 5 more sources; concurrency keeps latency
roughly at the slowest single call rather than the sum.

### D9. Selection order vs. presentation order
Budget selection runs in three passes (agent messages → floors → global rank with
caps), but the final injected list is always ordered by composite rank.
*Why:* pass structure is an admission policy, not a display order; presentation should
still read most-important-first.

---

## 3. Change Log (file by file)

| # | File | Change | Why |
|---|------|--------|-----|
| 1 | `kolega_katra_bridge/personality.py` | **NEW.** `PersonalityProfile` dataclass, 10-profile registry, `resolve_profile()` with override merging. `agent_message` pinned to 10.0 unconditionally. | D3; single place to audit/extend personalities. |
| 2 | `kolega_katra_bridge/config.py` | Added `personality`, `source_weights`, `scoring` fields to `BridgeConfig` + JSON loading (`_dict` helper). Added `_expand_sources()` so legacy `"reflection"` expands to the three sub-sources. | D3, D6; full backwards compatibility — an untouched v1 config loads and runs. |
| 3 | `kolega_katra_bridge/katra_client.py` | Retagged reflection fetches to `daily_reflection` / `philosophical_insights` / `unresolved_threads`. Added `get_emotional_context()`, `list_missions()`, `explore_graph()` client methods (same fail-open style as existing methods). | D6, D7. |
| 4 | `kolega_katra_bridge/retriever.py` | **Rewritten.** Profile-driven weights; k-multiplied relevance term; power-law recency; concurrent fetch via `asyncio.gather`; three-pass budget (agent-first, floors, capped fill); dreamer's score-weighted vector sampling; naive entity extraction for emotional probes; per-source debug logging of fetch counts and token usage. | D1, D2, D4, D5, D8, D9. |
| 5 | `kolega_katra_bridge/formatter.py` | Reflection section now groups the whole reflection family (old + new labels). | D6; keeps the "REFLECTION STATE" prompt block intact after the split. |
| 6 | `kolega_katra_bridge/hook.py` | Cache key now includes the personality name. | Switching profiles mid-session must not serve stale cached context. |
| 7 | `katra-hook.personality.example.json` | **NEW.** Annotated example config demonstrating profile selection, overrides, and recommended budgets. | Documentation / onboarding. |
| 8 | `config.py`, `README.md` (root + bridge) | Default `max_context_tokens` raised **2500 → 5000**. | Ten sources at 2,500 tokens was too tight for the personality loop to express itself; 5,000 lets interiority-heavy profiles coexist with task context. Per-deployment configs still override. |

**Explicitly unchanged:** dedupe logic (SHA-256 of normalized first 500 chars), empty-placeholder
filtering, 8,000-char per-item cap, MCP transport, agent-message search queries, the
`<katra-memory>` prompt block format.

---

## 4. The Personality Registry (reference)

`agent_message` = 10.0 in all profiles (pinned). k = relevance multiplier,
HL = recency half-life in days.

| Source | balanced | legacy | scholar | pragmatist | strategist | historian | empath | analyst | sentinel | dreamer |
|---|---|---|---|---|---|---|---|---|---|---|
| daily_reflection | 3.0 | 8.0 | 6.5 | 1.5 | 3.0 | 4.5 | 6.0 | 2.0 | 1.5 | 4.5 |
| philosophical_insights | 2.0 | 8.0 | 7.5 | 0.5* | 2.0 | 2.5 | 2.5 | 1.5 | 0.5* | 6.5 |
| unresolved_threads | 2.5 | 8.0 | 4.5 | 1.5 | 6.5 | 2.0 | 4.5 | 1.5 | 4.0 | 3.0 |
| working_memory | 4.0 | 3.0 | 2.5 | 7.0 | 4.0 | 3.0 | 3.5 | 4.0 | 7.0 | 2.5 |
| temporal_context | 3.0 | 2.5 | 2.0 | 6.0 | 3.0 | 6.0 | 3.0 | 3.0 | 7.5 | 2.0 |
| vector_search | 5.0 | 2.0 | 5.0 | 5.0 | 4.5 | 4.0 | 3.5 | 7.5 | 3.0 | 6.0 |
| temporal_recall | 1.5 | 1.0 | 1.0 | 3.0 | 1.5 | 7.0 | 4.0 | 2.5 | 5.0 | 4.0 |
| emotional_context | 2.0 | 0 | 2.0 | 1.0 | 1.0 | 2.0 | 8.0 | 1.0 | 1.5 | 4.5 |
| missions | 2.0 | 0 | 1.5 | 5.5 | 8.0 | 1.5 | 1.5 | 2.0 | 3.5 | 1.0 |
| knowledge_graph | 2.0 | 0 | 4.0 | 2.0 | 5.5 | 3.5 | 1.5 | 6.5 | 1.5 | 3.5 |
| **k** | 2.0 | 1.0 | 2.0 | 2.0 | 2.0 | 2.0 | 2.0 | **3.0** | 2.0 | 2.0 |
| **HL (days)** | 14 | 30 | 21 | 10 | 14 | **90** | 14 | 14 | **4** | 30 |

\* Below `min_fetch_weight` (1.0) — the source is never fetched for this profile.
`dreamer` additionally fetches 15 vector candidates and samples 5 score-weighted at
random (loose association as a creativity mechanism). `sentinel` raises floors to
working_memory 20% / temporal_context 15% / vector_search 10%.

**Recommended budgets:** scholar/empath/dreamer 4,000–5,000 tokens (interiority needs
room to coexist with task context); pragmatist/sentinel 2,500 (context-lean *is* the
personality); others 3,000–4,000.

---

## 5. Verification Performed

Unit harness executed against the modified package (all passing):

1. Config with legacy `"reflection"` source expands to the three sub-sources; unknown personality names fall back to `balanced` with a warning.
2. `agent_message` weight remains 10.0 even when a config override attempts to lower it; unknown source names in overrides are ignored with a warning.
3. **Cue-dominance:** a relevant vector hit (score 0.95) outranks an irrelevant same-day reflection under `balanced`; the identical items rank the opposite way under `legacy` — confirming both the fix and the A/B control.
4. **Floors + cap:** with six high-ranked reflections competing against one working-memory and one vector item at 2,500 tokens under `scholar`, the final context contains working_memory and vector_search (floors) and at most 40%-worth of reflection items (cap).
5. `agent_message` items are always admitted and presented first.
6. All 10 profiles are structurally valid (known sources only, pin intact).
7. Power-law recency: same-day ≈ 1.0; 60-day-old at HL 14 ≈ 0.19 (no cliff).
8. Dreamer sampling reduces 15 vector candidates to exactly 5 without error.
9. Formatter still renders the bulletin and reflection sections after the source split.
10. Entity extraction: `"How does Katra handle the MongoDB index issue?"` → `["Katra", "MongoDB"]`.

**Suggested live verification (post-deploy):**
- Set `"debug": true` and confirm the log line `Katra fetch [personality=...]` shows expected per-source counts, and the injection line shows per-source token usage respecting floors/caps.
- Run the same prompt under `legacy` vs `balanced` and diff the injected `<katra-memory>` blocks.
- Latency check: total retrieval time should now approximate the slowest single MCP call, not the sum.

---

## 6. Rollback

Three independent levels, no code reverts needed for the first two:

1. **Config-level (instant):** set `"personality": "legacy"` — reproduces v1 ranking exactly (weights, k=1.0, 30-day-equivalent recency, no floors/caps, new sources weight 0).
2. **Config-level (partial):** keep `balanced` but neutralise features via `"scoring"`: `{"relevance_multiplier": 1.0, "budget_floors": {}, "max_single_source_pct": 1.0}`.
3. **Code-level:** `git apply -R personality-retrieval.patch` restores v1 files verbatim.

---

## 7. Roadmap / Follow-ups (not in this change)

**Phase 4 — Close the consolidation loop.** Apply the same personality weights (or a
smoothed version) to the material sampled by `trigger_reflection` on the server side.
Without this, uniform consolidation sampling will partially re-converge the
personalities overnight. This is a server change (`sleep-consolidation` service), out
of scope for the bridge.

**Phase 5 — Drift instrumentation.** Log the source composition of every injected
context (the debug line already emits it) to a time series, and add lightweight
linguistic markers on agent output (self-reference rate, abstraction level, sentiment).
The research claim requires showing the agent *became* more scholarly, not merely that
more reflection text was present in context.

**Phase 6 — Graph-assisted entity extraction.** Replace the naive capitalised-token
heuristic for `emotional_context` with an `explore_graph` lookup: probe emotions only
for entities that actually exist in the knowledge graph.

**Phase 7 — Self-directed personality development.** Allow sleep consolidation to
propose bounded adjustments to the agent's own `source_weights` (e.g. ±0.5 per week
within [0.5, 8.0], floors/caps immutable). This is the natural endgame of the thesis:
personality that not only emerges from the loop but is steered by it.

---

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Latency growth from up to 5 extra MCP calls | Concurrent gather (D8); `min_fetch_weight` skips low-weight sources; new sources are opt-in via `sources`. |
| Rumination spiral in reflection-heavy profiles | Homeostatic cap (D5) + floors (D4). Watch drift metrics (Phase 5). |
| Personality skew degrades task performance | Floors on working_memory/vector_search; k=2 lets relevant memories break through; `legacy` A/B control quantifies any regression. |
| `get_emotional_context` probes on garbage entities | Max 2 probes/prompt; fail-open; Phase 6 replaces heuristic. |
| Config typos silently change behaviour | Unknown personalities/sources logged as warnings and ignored; invariants (agent_message pin) enforced in code, not config. |
| Stale cache after profile switch | Personality name is part of the cache key. |
