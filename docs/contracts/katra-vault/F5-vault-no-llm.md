# CONTRACT — F5: Katra Vault no-LLM guarantees (pipeline denylist)

Source of truth: `docs/katra-vault-design.md` §7.1 (objective O3, guard 1 of 3).

## Goal
Make it structurally impossible for vault material to reach an LLM: an explicit
collection denylist module consulted by every memory-processing read path that
can feed documents to LLM calls, plus a security test that proves no LLM call
ever receives a document from a denylisted collection.

## Boundaries — MUST NOT touch
- `server/src/routes/**`, `server/src/mcp-server.ts`, `dashboard/**`
- `server/src/services/vault/{crypto,store}.ts` (consume only)
- Any LLM call semantics, prompts, or processing behavior — the guard is a
  **read gate**, it may only THROW when a denylisted collection is about to be
  read by a processing path; when the collection is allowed, behavior must be
  byte-for-byte unchanged.
- `server/package.json`, `install.sh`, `.env.example`

## Files this feature may create/modify
- NEW `server/src/services/vault/denylist.ts`
- MODIFY the LLM-facing read choke points in the processing/embedding/graph
  pipeline (identified by reading the code — e.g.
  `services/processing/{background-processor,extraction-service,sleep-consolidation-service,
  operational-distillation-service,context-synthesis-service}.ts`,
  embedding read paths, knowledge-graph synthesis read paths, reflection
  summarization paths). Guard calls ONLY at the point where a collection is
  named for reading — never inside LLM call bodies (so the mock-LLM security
  test can prove containment).
- NEW `server/tests/security/vault-denylist.test.ts`

## Denylist module (exact interface)
```ts
export const VAULT_DENYLISTED_COLLECTIONS: readonly string[] = [
  'secrets', 'vault_approvals', 'vault_audit', 'auth_sessions', 'auth_totp',
];
export function isVaultDenylisted(collection: string): boolean;  // exact match
export function assertVaultCollectionAllowed(collection: string, context: string): void;
// throws Error(`vault: denylisted collection '${collection}' blocked in ${context}`)
// when isVaultDenylisted(collection); returns undefined otherwise.
```
Do NOT invent prefix/tenant variants — exact collection names only.

## Guard wiring requirements
1. Find every processing path that reads documents from a **named collection**
   and can hand them to an LLM (embedding generation, semantic extraction,
   summarization, sleep consolidation, reflection, knowledge-graph synthesis,
   pattern/anomaly detection, operational distillation). For each, insert
   `assertVaultCollectionAllowed(<collectionName>, '<module>:<function>')`
   immediately before the read.
2. The guard must be cheap and synchronous (no DB calls).
3. Existing tests must still pass — the guard only throws for the 5 vault
   collections, which no existing pipeline path reads today (if one DOES read
   them today, that is a defect to report, not to paper over).

## Security test requirements (tests/security/vault-denylist.test.ts)
1. Unit: `isVaultDenylisted` true for all 5, false for similar names
   ('secrets_backup', 'vault', 'auth_totp_x', 'episodic_events').
2. Unit: `assertVaultCollectionAllowed` returns undefined for allowed names
   and throws with 'vault: denylisted collection' for each of the 5.
3. Behavioral containment (the core proof): for each processing path that was
   guarded, insert a document into the **denylisted collection** in a test DB
   whose content contains a unique marker string (`VAULT_MARKER_<rand>`), then
   run that processing path with a mock/injected LLM that records every prompt
   it receives; assert the path threw the denylist error (or skipped) AND the
   mock LLM never received the marker. Use the repo's existing test seams for
   LLM injection — find them first (e.g. how existing tests mock the LLM or
   embeddings); if a path has no injection seam, test it at the guard level
   (direct call to the exported function containing the guard) and note it.
4. Regression: allowed collections still flow (episodic_events doc with a
   different marker IS seen by the mock LLM in the guarded extraction path,
   proving the guard doesn't over-block).
5. Test uses test_-prefixed collections + cleanup; no production data touched.

## Success criteria
1. `isVaultDenylisted` / `assertVaultCollectionAllowed` behave exactly per the interface.
2. Every LLM-facing document-read choke point found in the pipeline calls the guard (Verifier re-derives this list independently and compares).
3. Security test passes: marker never reaches a mock LLM from any denylisted collection; allowed collections unaffected.
4. Full suite: zero NEW failures (5 known pre-existing allowed; the code-graph/mcp-tools connected-suite hook timeout may appear when live Mongo is reachable — it is pre-existing/environmental).
5. `npx tsc --noEmit` clean.

## Acceptance command
```
cd server && npx vitest run tests/security/vault-denylist.test.ts && npm test
```

## Implementation notes
- Study `services/processing/*.ts`, the embedding service, and graph synthesis
  to find the read choke points. Prefer guarding at the fewest points that
  dominate all LLM-facing reads (e.g. a shared `readDocuments(collection)`
  helper if one exists) over scattering dozens of calls.
- Keep diffs minimal and behavior-preserving for allowed collections.
- Report in your structured output: the exact list of files/functions guarded
  and the reasoning for each choke point.
