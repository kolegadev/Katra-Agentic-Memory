# Design Note — Coding-Domain Memory

**Status:** draft for review · **Source:** CTO meeting notes, 2026-07-22
**One-liner:** Specialize Satori for software development by biasing the *semantic distillation* prompts toward code-domain facts — kept minimal, optionally run on a coding-specialized model — with a light dev system-prompt fragment.

This note interprets the meeting notes and maps them to concrete integration points. It is deliberately small: the guiding constraint from the notes is **"not too many rules."**

---

## What we're trying to do

Make Satori a better memory for engineering work: capture and surface the things that matter in a codebase — conventions, architectural decisions, API/interface contracts, library choices, "we do X this way" — instead of treating code sessions as generic conversation.

Two sub-goals, ordered by priority:

1. **Domain-aware distillation** (start here) — teach the fact-extraction layer to recognize coding-domain signal.
2. **Dev system-prompt fragment** (second) — prime the LLM's framing for a software-engineering memory.

Explicitly *out of scope for v1*: a rules engine, per-language config matrices, or a broad system-prompt rewrite.

## Why start at semantic distillation

Distillation is the layer that turns raw episodic events into structured, reusable knowledge. Everything downstream — the knowledge graph, time-block summaries, recall, reflection — inherits whatever distillation captures. Biasing it toward code facts is therefore the **smallest change with the widest reach**, which is exactly what "start at distillation" points to.

## Integration points (where to add in)

| Concern | File / component | Change |
|---|---|---|
| **Fact/entity extraction** | `services/processing/extraction-service.ts` | Add a coding-domain hint to the extraction prompt: prefer entities like *component, module, API, config key, decision, dependency*; capture relationships like *depends-on, replaces, decided-against*. |
| **Graph compaction** | `services/memory/semantic-memory-service.ts` (`compactEpisodicToGraph`) | Same domain bias for triplet extraction into `memory_nodes` / `memory_edges`. |
| **Dev system prompt** | `services/integration/capability-card.ts` | Add a short, optional software-engineering framing fragment (behind a flag/scope), not a rules list. |
| **Coding-specific LLM (distillation only)** | `services/infrastructure/llm-service.ts` | See below — new capability. |

## The "coding-specific LLM" — distillation scope only

Confirmed intent: run **only the distillation step** on a code-specialized model; chat, reflection, and consolidation stay on the general LLM.

Current state (verified): `LLMService.chat()` takes `{temperature, maxTokens}` and always selects the first available provider — there is **no per-task model routing** today. So this is a genuine (small) addition, not a config flip:

- Extend `chat()` (or add a thin wrapper) with an optional `purpose` / model override, e.g. `chat(messages, { purpose: 'distillation' })`.
- Let a distillation model be configured alongside the primary one (extend the DB config that `get_llm_config_from_db` / `configure_llm` already manage, rather than adding new infra).
- Fall back to the primary model when no distillation model is set — zero-config stays working.

## Ground truth (verified in code)

Before the plan, the facts that shape it:

- Both distillation LLM calls live in **`services/infrastructure/llm-service.ts`**:
  - `extractStructuredData()` → `extractSingleChunk()` sends the global `EXTRACTION_SYSTEM_PROMPT` (llm-service.ts ~L802) on `provider.model`. This is the fact distiller.
  - `extractJson()` (llm-service.ts ~L593) is used by `semantic-memory-service.ts` `extractTriplets` for graph compaction, with an inline system prompt built in that service.
- Provider selection is `getActiveProvider()` = `providers.find(p => p.available)`, and `apply_config()` **clears `providers[]` and pushes exactly one**. So there is *no* per-task model routing today — the coding model is a genuine (contained) addition, not a config flip.
- `LLMConfig` = `{provider, api_key, base_url, model}`, persisted to `system_settings.llm_config`; written by `configure_llm` (MCP) / admin route → `apply_config()`. `validateBaseUrl()` already guards SSRF and is reusable.

## Implementation plan

Three phases, each independently shippable, reversible, and separately reviewable. Total: Phase 1 ~half a day, Phase 2 ~1 day, Phase 3 ~half a day.

### Phase 1 — Domain-aware distillation (prompt + toggle only, no new infra)

Goal: bias fact extraction toward code-domain signal. Smallest change, widest reach.

- **Toggle:** add `MEMORY_DOMAIN` (values `generic` | `software`, default `generic`), read once at module load. Single flag — no rules matrix.
- **`llm-service.ts`:** define a ~6-line `CODING_DOMAIN_HINT` constant and append it to `EXTRACTION_SYSTEM_PROMPT` only when `MEMORY_DOMAIN=software`. Hint prioritises: architectural decisions + rationale, API/interface contracts, module boundaries, tooling/library choices, conventions, problem→resolution. Suggest (not enforce) relationship types `depends_on, replaces, decided_against, configures`. No schema/enum breaking changes.
- **`semantic-memory-service.ts`:** append the same hint to the triplet-extraction system prompt, behind the same flag.
- **Acceptance:** with the flag off, prompts are byte-identical to today (diff-verifiable). With it on, run ~5 real dev-session transcripts through extraction and confirm code-domain facts (decisions, contracts, conventions) are captured that generic mode missed.
- **Files:** `services/infrastructure/llm-service.ts`, `services/memory/semantic-memory-service.ts`, `.env.example` + `docs/CONFIGURATION.md`.

### Phase 2 — Distillation-only coding model

Goal: run *only* the two distillation calls on a code-specialised model; chat/reflection/consolidation stay on the primary.

- **Config:** extend `LLMConfig` with optional `distillation_provider`, `distillation_model`, `distillation_base_url`, `distillation_api_key`. Persist in the same `llm_config` doc. All optional → zero-config unchanged.
- **`llm-service.ts`:**
  - Add a separate `distillationProvider` slot (NOT the `providers[]` array — keeps existing `getActiveProvider()` chat callers untouched). Build its OpenAI client in `apply_config()`, reusing `validateBaseUrl()`.
  - Add `getDistillationProvider()` → distillation slot **or** fall back to primary provider.
  - Route the two call sites to it: `extractSingleChunk()` uses the distillation provider; `extractJson()` gains an optional `purpose?: 'distillation'` param, and `semantic-memory-service.ts` passes `'distillation'`.
- **Config surface:** add the optional fields to the `configure_llm` MCP tool schema, the admin `configure_llm` route, `get_llm_config` display (show both models), and `DISTILLATION_*` env vars.
- **Acceptance:** with no distillation config, `getDistillationProvider()` returns the primary and behaviour is unchanged. With it set, extraction/compaction calls hit the code model (verify via logs/`get_llm_config`) while `generateResponse` still uses the primary. `response_format` unsupported by the code model degrades via the existing `extractJson` JSON-cleanup fallback.
- **Files:** `services/infrastructure/llm-service.ts`, `services/memory/semantic-memory-service.ts`, `routes/admin-routes.ts`, `mcp-server.ts` (`configure_llm` schema), `.env.example`, `docs/CONFIGURATION.md`.

### Phase 3 (optional) — dev system-prompt fragment

Goal: prime the agent's framing as a software-engineering memory.

- **`capability-card.ts`:** add a short (not a rules list) software-engineering framing fragment, gated by `MEMORY_DOMAIN=software`.
- **Acceptance:** fragment present only when the flag is on; no change to generic deployments.
- Deferred deliberately — the distillation bias does most of the work; only build this if Phase 1/2 leave a framing gap.

### Sequencing / dependencies

Phase 1 → Phase 2 → Phase 3, in order. Each merges independently. Phase 1 is the measurement gate: only proceed to the coding-model wiring (Phase 2) if Phase 1's fact-quality lift holds. Phase 3 is optional and last.

## Open questions for the CTO

- **Domain toggle granularity** — global mode, per-memory-scope/tenant, or per-session? (Affects whether the dev fragment and code model are always-on or opt-in.)
- **Which code model** for distillation, and self-hosted (Ollama) vs. API?
- **Success metric** — what does "better coding memory" look like concretely (fact precision, graph density on code entities, recall usefulness)?
