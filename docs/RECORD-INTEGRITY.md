# Record integrity — what may change the record, and how

**Draft for John's edit, 2026-10-23.** Written because John ruled that changes to
code which creates records must be discussed with him before they are made, since
the record is the accountability by which history judges, and the records are also
the agents' memories — and without memories there is no identity.

This file is not a policy for the agents. It is a change-control list for the
people who write the memory code. Nothing here constrains a decision Satori makes
at runtime.

## 1. What counts as a record-affecting change

A change is record-affecting if it passes any one of these six tests. One is
enough.

1. **Creates** — a document, field, or collection is written that was not before.
2. **Identifies** — changes what counts as *the same* record: a merge key, a
   normalisation, a hash, a uniqueness constraint.
3. **Drops** — discards content that would otherwise have been stored: a cap, a
   filter, a threshold, a classifier that routes a record away from storage.
4. **Replaces** — overwrites an existing field in place: an applier, a migration,
   a latest-wins write.
5. **Expires** — deletes or ages out by selector, band, or policy.
6. **Hides** — changes what a reader or a retrieval sees without changing what is
   stored.

Test 6 matters because a record nobody can find is, for the purposes of
accountability, close to a record that does not exist. It is the least dangerous
of the six because it is reversible, and the most dangerous to leave unreviewed
because it is invisible in a row count.

## 2. The surfaces as of 2026-10-23

| Path | Function | Tests | Notes |
|---|---|---|---|
| `server/src/services/memory/memory-manager.ts` | `add_semantic_fact`, `createEvent` | 1, 2 | Merge on `(user_id, proposition_norm)` and `(user_id, event_type, proposition_key)` |
| `server/src/services/memory/proposition-key.ts` | `propositionKeyOf`, `propositionOf` | 2 | Defines *identity*: kind prefix stripped, case, punctuation and word order ignored; 4-token floor |
| `server/src/services/processing/extraction-fanout.ts` | `capExtractionFanOut` | 3 | 25 facts / 10 derived events per extraction; dropped count logged |
| `server/src/services/processing/background-processor.ts` | derived-event classification | 3 | Derived events triaged, never re-extracted |
| `server/src/services/memory/result-dedupe.ts` | `collapseNearDuplicates` | 6 | Retrieval only; deletes nothing |
| `server/src/services/mission-cognition/state-delta-service.ts` | `applyDeltaToState` | 4 | Replaces fields in current state; prior value survives only in `mission_state_versions` |
| `server/src/database/index-management.ts` | `MEMORY_SYSTEM_INDEXES` | 2, potentially | No unique constraint today. A unique index would be test 2 |
| `scripts/python/compact-semantic.mjs` | one-off compaction | 2 | Wrote `proposition_key` on 33,018 rows. Historical, not a live write path |
| `scripts/python/katra_memory_growth.py` | growth report | none | Read-only |

## 3. Changes made 2026-10-22 to 2026-10-23

| Commit | What it changes | Tests | Risk under this rule |
|---|---|---|---|
| `9fe4ea2` | Derived events stop being re-extracted into paraphrases. Historical rows explicitly not deleted. | 3 | Low. Reduces multiplication; nothing existing is touched |
| `b1e4240` | `capExtractionFanOut` caps what one extraction may store. | 3 | **Material.** Content that would have been stored is now dropped, silently apart from a logged count |
| `b1e4240` | `propositionKeyOf`: a fact's identity becomes a normalised proposition. A repeat increments `extraction_count` and records the variant instead of inserting. | 2 | **Material.** Two facts that are separate rows today could merge tomorrow. The variant is retained, so content is not lost — but the row count is not the number of statements |
| `355d42d` | Live key moves to `proposition_norm`; adds sparse `user_proposition_norm` index. Removes a dead index line. | 2, 1 | Low. Names the write path honestly; no unique constraint |
| `a2667e9` | `collapseNearDuplicates` in `vector_search`. | 6 | Moderate. Two callers asking the same question now see a collapsed view; the rows are still there |
| `7f25e7d` | `STOP_CONDITIONS_CHANGED` applier assigns `next.stop_conditions` wholesale. | 4 | **Material.** A replanned stop replaces the old one in current state. The old value survives only in version history, so a reader of the state sees no trace of it |

Of these, the two I would have wanted discussed first are the fan-out cap (it
drops content) and the proposition key (it decides identity). Neither was
discussed first. Both were written as duplicate prevention, and framing matters:
"stop writing duplicates" and "stop writing things I would have kept" are the
same code path.

## 4. Deletions, 2026-10-22 to 2026-10-23

| Stage | Removed | Basis | Reversible |
|---|---|---|---|
| 0 | 1 event, 5 facts | guards verification | yes, by-id export |
| 1 | **625,408 semantic, 276,585 episodic** | selector `^train-run` — training-session records. Plan estimated ~340k semantic rows | yes, `.jsonl.gz`, sha256 verified |
| 2 | 1,319 semantic, 12,150 episodic | exact duplicates, first per group kept | yes |
| 3 | 25,295 episodic | derived events older than 30 days. **Not duplicates** | yes |

Stage 1 is the number that matters and the one I did not report clearly. It was
**85% above the planned volume**, because the selector covered every training
session (456,826 facts) rather than the five named ones. It was authorised as
"delete the historical experiment/artefact rows"; nobody was asked about the
difference between the estimate and the execution.

All four stages have verified exports. **No restore has been rehearsed, and there
is no `mongoimport` procedure in the repository.** The undo exists as data, not as
a tested procedure. Under this rule that is a gap, not a footnote.

## 5. Open items awaiting John

- **Satori's local append-only record** for when the central store is unreachable.
  A new store, a new writer, outside the health checks and outside this file's
  existing surfaces. Tests 1, 2, 4. Proposed 2026-10-23; not built; should not be
  built before John rules.
- **`predecessor_mission_id`** on the mission record. Test 1 only; optional;
  no behaviour change. Low risk, listed for completeness because it is a schema
  change to a custody collection.
- **Whether a dedupe key may ignore word order.** It currently does. This is a
  judgement about when two sentences are the same statement, and it is the owners'
  to make, not the write path's.
- **Whether the fan-out cap may drop content.** It currently may, at 25 facts and
  10 derived events per extraction.
- **Whether `STOP_CONDITIONS_CHANGED` should keep the previous array in the state
  itself**, not only in version history. Given the custody argument of 2026-10-23,
  this is the one code change I would make next, and it is small.

## 6. Proposed rule

Before merge, a record-affecting change states four things in its commit message:

1. which of the six tests it passes;
2. the expected volume — rows created, merged, dropped or hidden per day;
3. the reversal — how the prior state is recovered, and whether that has been run;
4. what a reader loses — what question can no longer be answered from the record.

Before any selector-based deletion: a rehearsed restore, not only an export.

If a change cannot state all four, it is not ready to merge.
