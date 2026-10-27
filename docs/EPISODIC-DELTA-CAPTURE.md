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
