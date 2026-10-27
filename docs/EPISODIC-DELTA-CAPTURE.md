# Episodic delta capture — what a turn records, and why near-duplicates piled up

2026-10-21 · the loop director, at the operator's direction.

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
   transcript arrives with different wording — "Get from the generator the
   reflection-stall root cause" and "Obtain from the generator the reflection-stall
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
| other (161 mergeable types) | 21,902 | 21,613 | 1.3% |
| **total (all 167 mergeable types)** | **946,688** | **437,026** | **53.8%** |

Those percentages were measured under the original sort-and-drop normal form.
The 2026-10-27 rule (below) is deliberately more conservative: negations,
numerals and token order now distinguish propositions, so some of those groups
split rather than merge.

The extreme case: *"katra-server was restarted to recover from an unhealthy
state."* was stored **4,759 times**.

## The rule

A distilled event's identity is its **proposition**, not its bytes
(`server/src/services/memory/proposition-key.ts`).

- Normalise the description: lowercase, strip punctuation, drop stopwords, and
  keep the remaining tokens **in order**. Negations (`not`, `no`) and
  one-character numerals are content, not noise: "did not fail" and "did fail",
  and "version 1" and "version 2", must not share a key. The cost is that a
  re-wording which reorders the tokens no longer merges; that is the safer
  failure. (Changed 2026-10-27 from the original sort-and-drop rule; keys
  written before that date are a different generation and are re-keyed by the
  compaction scripts.)
- Hash `event_type + normalised text`. Volatile fields — timestamps, ids,
  extraction metadata — are deliberately excluded, because they are exactly what
  made every copy unique.
- On write, if an event with the same `(user_id, event_type, proposition_key,
  shared_id)` exists, **merge**: `occurrences += 1`, `last_seen_at` advances,
  the latest session and shared scope are kept, and a new wording is appended to
  `variants` with its session, shared scope and time; variants are capped at
  five (first wording is canonical). On the `latest` strategy the survivor also
  refreshes `content_hash`, `idempotency_key` and clears `metadata.processed`,
  so the new rationale is not treated as already processed.
- A minimum of four content tokens is required for prose. Shorter descriptions
  are too generic to identify a proposition. (Measured: lowering the bar to 3
  tokens would collapse only 2,294 further rows — not worth the risk.)
- **Structured decisions** (`gas_law_train_decision`) carry no description but
  identify themselves by `(cell_id, action)`. They merge on that key and keep
  the **latest** rationale, because the newest evidence is the current truth.

The semantic-fact merge uses the same `shared_id` scope: a re-wording keeps the
existing fact's confidence, source, tags and metadata (merged, not replaced) and
records the new source-event lineage before returning.

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

- Index `proposition_lookup` on `(user_id, event_type, proposition_key,
  shared_id)` makes the merge lookup cheap; the runtime creates it at startup,
  and `compact-episodic.mjs --apply` ensures the same shape on an existing
  store. After the duplicate groups are deleted, compaction replaces it with a
  unique sparse index on the same key (partial on `proposition_key` existing),
  which is the atomic guard against concurrent first-writes; the insert path
  re-reads and merges when that index returns a duplicate-key error.
- `compact-semantic.mjs --apply` does the same for
  `(user_id, proposition_key, shared_id)` (`semantic_proposition_scoped`), and
  keeps a non-unique `(user_id, proposition_norm, shared_id)` lookup for rows
  written before the field rename.
- `scripts` (in the run history): `compact-episodic.mjs` (dry run by default,
  `--apply` to write), `compact-gaslaw.mjs`, and `compact-semantic.mjs`. All
  three finish the export stream before deleting.
- Exports are gzipped JSONL, one line per removed document, written to
  `EXPORT_DIR` (default `/app/exports`, the bind-mounted `exports/`) and named
  `<collection>-merged-<timestamp>.jsonl.gz`.
- The 2026-10-22 `semantic_facts` export predates that path: it was written to
  the container's `/tmp` and is not on the host. Its 54,812 removed rows were
  exact-normalised duplicates of survivors, so no proposition was lost, but the
  per-duplicate timestamps and session ids are not recoverable.
- `compact-semantic.mjs --repair-timestamps --apply` rebuilds
  `first_seen_at`/`last_seen_at` from `created_at`/`updated_at` on the 17,710
  survivors written with 1970 timestamps by the first run.
- Re-running the scripts is idempotent: already-merged rows have one member per
  group and are skipped.

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

## Second round (same day, the operator's four follow-ups)

### semantic_facts

895,399 documents scanned → 840,631 propositions; 33,018 duplicate groups,
**54,812 redundant rows (6.1%)**, exported and removed. Logical size 4,942 →
4,649 MB. The remaining 4.6 GB is not duplication: it is 384-dimension
embeddings (one per fact, ~895k of them). Dedupe here is worth doing and is
cheap, but it is not where the space goes.

The first semantic compaction projected `timestamp`, which `semantic_facts`
does not carry (84 of 228,709 rows have it). Survivors written from an absent
field got 1970-01-01 as `first_seen_at`/`last_seen_at` — 17,710 rows. The
script now maps `created_at` → `first_seen_at` and `updated_at` →
`last_seen_at`, and `compact-semantic.mjs --repair-timestamps --apply` rebuilds
the rows written before that fix.

The compaction also writes the plain normalised proposition string to both
`proposition_key` and `proposition_norm` — the same value `propositionKeyOf`
writes at runtime — not a SHA-256 hash, so a compacted row can still be matched
by the next merge. The runtime merge reads both field names for the same
reason: rows written before the field rename carry `proposition_norm`.

### The paraphrase experiment — a negative result, kept on the record

A Jaccard gate was built and deployed: merge when the token overlap with a
recent event of the same type is ≥ 0.8. The live acceptance test killed it:

| pair | overlap | result |
|---|---|---|
| "Get the reflection root cause from the generator" / "Obtain …" | 4/5 = 0.80 | merge (intended) |
| "Delete the reflection root cause from the generator" / "Get …" | 4/5 = 0.80 | **merge (wrong)** |

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

## Watching it — the memory-growth check

The dedupe changes are only worth what the next weeks show. `scripts/python/katra_memory_growth.py`
measures the store and appends a labelled block to `~/.katra/inbox/health-reports.md`,
so it is in front of the 07:30Z review; cron runs it at 06:50 local
(Europe/Jersey), i.e. 05:50Z in BST and 06:50Z in GMT.

It reports five numbers, one verdict, and two flow ceilings:

| number | why it matters |
|---|---|
| docs, and docs added in 24h | raw rows are expected to grow (health samples, messages) and say nothing about the merge |
| propositions omitted by `prop_rows` | **new propositions are the only row growth that means duplication escaped** |
| occurrences represented | repeats absorbed into an existing row |
| session cursors | how many sessions are extracting deltas |
| derived events / semantic facts added in 24h | flow ceilings: >5,000 derived or >8,000 facts prints `** FLOW ABOVE CEILING **` |

The verdict compares new propositions against absorbed repeats:

- `0 new propositions, >0 occurrences` → **FLOW STEMMED**: every repeat went into an existing row.
- `>= 1 repeat absorbed per new proposition` → **ABSORPTION WORKING**.
- more new propositions than absorbed repeats → **REVIEW**: that ratio is worth a look.
- rows added but 0 new propositions → **KEY NOT WRITTEN**: the write path is not keying them; the check must not read as quiet.
- store shrank (a compaction) → **COMPACTION SEEN**: deltas restart here.
- nothing moved at all → **NO ACTIVITY**, which is not a pass; it says nothing either way.

Baseline, 2026-10-22 06:37Z: **365,635 docs, 55,501 propositions, 663,666 occurrences,
3 cursors**; 4,726 rows added in the previous 24h, of which only **105** were new
propositions. The script pins the two propositions this work found most
duplicated — "katra-server was restarted to recover from an unhealthy state"
(4,759), "katra-server experienced an outage." (4,360) — and reports their row
and occurrence counts directly each run, alongside the six highest-occurrence
propositions. If a pinned sentinel climbs in `occurrences` while the row count
stays flat, the merge is doing its job; if it reappears as **new rows**, the key
is leaking. A pinned sentinel with 0 rows is reported as 0, not as flat.

A JSON baseline is kept at `~/.katra/inbox/memory-growth-baseline.json`, so each
run reports deltas since the previous one rather than absolute numbers alone.
