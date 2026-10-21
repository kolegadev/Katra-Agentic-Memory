# Episodic delta capture — what a turn records, and why near-duplicates piled up

2026-10-21 · Lilly, at John's direction.

## The problem as stated

Each turn of a chat re-writes a growing transcript. The incremental output is
small compared with the prefix, so records that describe the same thing keep
reappearing with slightly more input and a slightly different wording. Near
duplicates are the worst case for retrieval: lexically and semantically every
candidate looks like every other, so a search returns a wall of clones. The ask
was to review what is recorded per turn, capture the **delta** rather than the
clone, cut the storage, and make search usable again.

## What the measurement showed

Before changing anything, the store was measured (`episodic_events`, 2026-10-21):

| | |
|---|---|
| documents | 969,674 |
| on disk | 3.45 GB data · 169 MB index |
| `conversation` events | 2,989 (26 MB) |
| `problem` | 270,431 (1,411 MB) |
| `decision` | 246,279 (1,169 MB) |
| `gas_law_train_decision` | 192,990 (732 MB) |
| `solution` | 78,628 (403 MB) |
| `goal` / `plan` | 68,587 / 67,864 (342 / 297 MB) |

So the raw chat turns were **not** the problem — 2,989 conversation events, and
consecutive messages in the busiest session shared an average common prefix of
15 characters. The duplication was one layer up, in the **distilled** events
(`problem`, `decision`, `solution`, `goal`, `plan`) that the extraction service
writes after reading a session.

Two mechanisms produced it:

1. **The dedup key could not match.** `EpisodicEventManager.generateContentHash`
   hashes the *whole* content payload; extracted events embed a fresh
   `extracted_at` (and a session id) inside that payload. Every re-extraction is
   therefore byte-different and dedup never fires, even when the proposition is
   identical.
2. **The extractor paraphrases.** The same fact re-derived from an unchanged
   transcript arrives with different wording — "Get from Satori the
   reflection-stall root cause" and "Obtain from Satori the reflection-stall
   root cause" are two rows, 15 minutes apart.

Measured collapse under an order-insensitive normal form:

| type | rows | propositions | redundant |
|---|---|---|---|
| problem | 270,432 | 74,186 | 72.6% |
| solution | 78,628 | 18,077 | 77.0% |
| goal | 68,587 | 12,227 | 82.2% |
| plan | 67,867 | 30,580 | 54.9% |
| decision | 246,282 | 173,026 | 29.7% |
| gas_law_train_decision | 192,990 | 107,317 | 44.4% |
| **total (measured types)** | **946,688** | **437,026** | **53.8%** |

The extreme case: *"katra-server was restarted to recover from an unhealthy
state."* was stored **4,759 times**.

## The rule

A distilled event's identity is its **proposition**, not its bytes
(`server/src/services/memory/proposition-key.ts`).

- Normalise the description: lowercase, strip punctuation, drop stopwords, sort
  the remaining tokens. Sorting makes "X from Y" and "Y from X" the same
  proposition; the cost is that word order no longer distinguishes meaning,
  which is acceptable for short extracted statements.
- Hash `event_type + normalised text`. Volatile fields — timestamps, ids,
  extraction metadata — are deliberately excluded, because they are exactly what
  made every copy unique.
- On write, if an event with the same `(user_id, event_type, proposition_key)`
  exists, **merge**: `occurrences += 1`, `last_seen_at` advances, and a new
  wording is appended to `variants` (first wording is canonical).
- A minimum of four content tokens is required for prose. Shorter descriptions
  are too generic to identify a proposition. (Measured: lowering the bar to 3
  tokens would collapse only 2,294 further rows — not worth the risk.)
- **Structured decisions** (`gas_law_train_decision`) carry no description but
  identify themselves by `(cell_id, action)`. They merge on that key and keep
  the **latest** rationale, because the newest evidence is the current truth.

Raw observation types are never merged: `conversation`, `agent_message`,
`user_communication`, `machine_health`, `gas_law_watcher_cycle`,
`heartbeat_action`, `executive_action`, `action`, `tool_call`, `system`. A
repeated health sample or message is itself the signal.

## The backfill

Two passes, both export-first (`exports/`), with the export's line count
verified against the delete count before the run is considered successful.

| pass | before | after | store |
|---|---|---|---|
| propositions (167 mergeable types) | 969,766 docs | 468,382 docs (−501,384) | 4,518 → 2,163 MB |
| structured decisions | 107,266 gas-law rows | 521 rows (−106,745) | 2,157 → 1,612 MB |

Combined: **~1.07 M rows → 468k**, **~4.5 GB → ~1.6 GB on disk**, with the
multiplicity preserved as `occurrences` and the time span as
`first_seen_at`/`last_seen_at`. The largest single collapse: 4,759 → 1.

Survivors carry `proposition_key`, `occurrences`, `first_seen_at`,
`last_seen_at`, and up to five `variants`.

## Operating notes

- Index `proposition_lookup` on `(user_id, event_type, proposition_key)` makes
  the merge lookup cheap; it is created by the compaction script and costs about
  250 MB across the collection.
- `scripts` (in the run history): `compact-episodic.mjs` (dry run by default,
  `--apply` to write) and `compact-gaslaw.mjs`. Both refuse to delete without
  exporting first.
- Exports are gzipped JSONL, one line per removed document, named
  `exports/<collection>-merged-<timestamp>.jsonl.gz`.
- Re-running either script is idempotent: already-merged rows have one member
  per group and are skipped.

## Honest limits

- **Paraphrase beyond the normal form still slips through.** "Get" and "Obtain"
  are different tokens, so those two rows merge only when the rest of the
  wording coincides. A similarity threshold (token Jaccard ≥ 0.8 within
  type+user) would catch more; it was not enabled because a false merge loses a
  distinct recollection, which is worse than keeping a duplicate.
- **`gas_law_train_decision` keeps only the newest rationale.** The evidence
  history for a cell is in the trading project's own store, not here; this
  collection is memory, not the ledger.
- **The extraction pipeline still re-derives facts.** This rule makes the
  duplicates cheap and searchable; it does not stop the re-derivation. The
  upstream fix — extracting only the delta of a session rather than its whole
  transcript — is a separate change to the extraction service.
- **Deletes are deletes.** The export is the recovery path; it lives under
  `exports/` and should be retained until the next compaction is verified.

## Second round (same day, John's four follow-ups)

### semantic_facts

895,399 documents scanned → 840,631 propositions; 33,018 duplicate groups,
**54,812 redundant rows (6.1%)**, exported and removed. Logical size 4,942 →
4,649 MB. The remaining 4.6 GB is not duplication: it is 384-dimension
embeddings (one per fact, ~895k of them). Dedupe here is worth doing and is
cheap, but it is not where the space goes.

### The paraphrase experiment — a negative result, kept on the record

A Jaccard gate was built and deployed: merge when the token overlap with a
recent event of the same type is ≥ 0.8. The live acceptance test killed it:

| pair | overlap | result |
|---|---|---|
| "Get the reflection root cause from Satori" / "Obtain …" | 4/5 = 0.80 | merge (intended) |
| "Delete the reflection root cause from Satori" / "Get …" | 4/5 = 0.80 | **merge (wrong)** |

The verb carries the proposition, and it is the single token that differs, so
token overlap cannot separate a synonym from an antonym. The gate was removed
from the write path; the deterministic proposition key remains, because it only
merges what normalises identically. A paraphrase merge needs a semantic
threshold (embedding cosine ≥ 0.95) validated against antonym pairs before it
is safe to ship.

The failed test also merged three fixture strings into three real `goal` events
from the same session; those were repaired (occurrences reset, variants pulled)
the same evening.

### Occurrences were under-counted on legacy rows

`$inc: {occurrences: 1}` starts from zero, so a row written before this rule
reported 1 on its second sighting. The merge now uses a pipeline `$set` with
`$ifNull` so an absent counter counts as the one occurrence the row already is.
Verified: a row with `occurrences` unset, written twice, ends at 2.

### The upstream cause

`extractStructuredData` deduped entities across chunks but not the `knowledge`
and `activities` it also emits — a long transcript split into two overlapping
chunks produced the same fact twice. It also handed the last three messages to
the extractor as "Context" with no instruction to exclude them, so every turn
re-derived the facts of its own recent history. Three changes:

1. knowledge and activities are deduped across chunks (same normalised text,
   highest confidence wins), mirroring what entities already did;
2. the context block is labelled "reference only — do not extract facts from
   it";
3. the system prompt states scope explicitly: extract only from "Text to
   distill"; a fact that appears only in the context is not output.

### Disk reclaim

After both passes, `freeStorageSize` is 0 on both collections and the on-disk
sizes are already 1,457 MB (`episodic_events`) and 3,695 MB (`semantic_facts`).
WiredTiger reused the freed pages as new writes arrived, so `compact` would
return zero bytes and only block writes for its duration. It was not run, and
`compact` dry runs confirm `bytesFreed: 0`.
