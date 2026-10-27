# Personality registry

`registry.json` is the **single source of truth** for the ten memory personality
profiles: the eleven memory sources, the agent-message invariant, the default
scoring parameters, each profile's weights and overrides, and the recommended
token budgets.

Both runtimes consume it through generated artifacts — neither hand-maintains a
number any more:

| Artifact | Consumer |
| --- | --- |
| `server/src/services/integration/personality-profiles.generated.ts` | `personality-profiles.ts` (server routes, dashboard) |
| `integrations/kolega-code/kolega_katra_bridge/personality_registry.generated.py` | `personality.py` (Kolega Code bridge) |

## Regenerating

From the repository root:

```sh
node scripts/generate-personality-registry.mjs          # rewrite both artifacts
node scripts/generate-personality-registry.mjs --check  # verify; non-zero if stale
```

CI runs `--check`, and `server/tests/unit/personality-registry-parity.test.ts`
proves a fresh generation is byte-identical to the committed artifacts, so a
hand edit to either generated file fails the build. **Edit `registry.json`, then
regenerate — never the artifacts.**

## Schema (`registry_version` 1.0)

| Field | Meaning |
| --- | --- |
| `sources` | the eleven memory sources, in retriever order |
| `agent_message_weight` | `10.0`, immutable: inter-agent comms always rank first. No profile may restate it — the runtimes re-pin it last, even over a caller's override |
| `reflection_family` | the three sources the legacy `reflection` umbrella expands to |
| `default_scoring` | what every profile inherits: `k`, `half_life_days`, `cap_pct`, `floors`, `vector_fetch_limit`, `vector_sample`, `min_fetch_weight` |
| `profiles` | the ten profiles, in declaration order. Each entry carries `name`, `description`, its `weights` (the ten non-agent sources, in declaration order) and `scoring` (only the keys it overrides) |
| `recommended_budgets` | recommended context-token budget per profile |

Registry scoring keys are the field names the runtimes use, except `k`
(`relevance_multiplier`), `half_life_days` (`recency_half_life_days`), `cap_pct`
(`max_single_source_pct`) and `floors` (`budget_floors`) — the generator prints
that mapping into both artifacts.

Key order is significant and preserved: the Python artifact is a dict literal,
so weight and floor order is observable at runtime. Floats stay floats (`10.0`,
`5.0`) and counts stay integers (`vector_fetch_limit`, budgets) in both
artifacts.

### `server_description`

Only where the two runtimes historically worded a profile's `description`
differently, the server's own text is recorded as `server_description` and the
bridge keeps `description`. ITER-1 was a behaviour-preserving canonicalisation,
so it moved the values into the registry *without* changing what either runtime
prints — the registry records the divergence rather than silently editing one
side's user-visible copy. Today only `legacy` has one.

## Editing

1. Change `registry.json` (a profile's weights, a floor, a new budget).
2. `node scripts/generate-personality-registry.mjs`
3. `python3 integrations/kolega-code/scripts/test_personality_registry.py`
4. `cd server && npx vitest run tests/unit/personality-registry-parity.test.ts`

The generator refuses to render a registry that breaks the invariants it can
prove: the agent-message weight must be `10.0`, no profile may declare it, every
profile must carry exactly the declared sources, floors must stay within the
budget, and the ten profiles must each have a recommended budget.
