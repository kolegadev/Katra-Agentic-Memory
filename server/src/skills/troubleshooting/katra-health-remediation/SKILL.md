---
name: Katra Memory & Autonomy Health Remediation
category: troubleshooting
confidence: 0.5
status: candidate
source: auto-refined
uses: 1
successes: 1
failures: 0
failure_patterns: []
---

# Katra Memory & Autonomy Health Remediation

## Description
Detect and remediate degraded memory and autonomy conditions before they compound into stuck or silently failing pipelines. Applies the principle that detection without action is failure. Specifically guards against embed-stage livelocks where a short, junk-dominated candidate queue is repeatedly rejected by `shouldEmbed` while the pipeline logs `Embedded 0/N` as a successful line.

## Symptoms
- `Embedded 0/N` repeated across consecutive cycles with no progress.
- Candidate query remains identical or nearly identical over multiple runs.
- Short, low-information facts continuously selected for embedding while meaningful content is starved.
- Health checks report "operational" while actual memory write throughput is zero.
- Autonomy tasks are marked complete without any durable memory effect.

## Workflow

1. **Establish baseline health.**
   - Inspect recent logs for `Embedded <count>/<total>` lines.
   - Count consecutive cycles where `<count>` is 0.
   - Flag as livelock if `Embedded 0/N` appears 3 or more times in a row, especially with the same candidate population.

2. **Run the livelock signature check before doing any work.**
   - Scan log tail for the regex: `Embedded 0/\d+`.
   - If 3+ consecutive matches exist, do NOT proceed with normal embedding.
   - Enter remediation mode immediately. This check prevents the pipeline from wasting cycles against the same rejected candidates.

3. **Inspect the candidate queue.**
   - Log the full candidate query before `shouldEmbed` is called.
   - If the candidate set is unchanged across cycles, identify the head-of-queue bias.
   - Check for short junk facts: low character count, low information density, boilerplate status strings, or empty/whitespace-only content.

4. **Apply content-length filtering.**
   - Discard candidate facts below a minimum content length (e.g., fewer than 40 meaningful characters after trimming).
   - Reject candidates that contain no substantive tokens (only stopwords, timestamps, or artifact identifiers).
   - Ensure the filter is applied before `shouldEmbed`, not inside a per-item loop that can silently skip.

5. **Sort candidates oldest-first.**
   - Before building the candidate query, sort by ascending creation/insertion time.
   - This prevents a small set of stale junk facts from permanently dominating the head of the queue.
   - After sorting, verify the candidate set changed from the previous cycle; if not, force a queue rotation.

6. **Execute the remediation.**
   - Clear, archive, or deprioritize the identified junk candidates.
   - Re-run `shouldEmbed` over the filtered and sorted set.
   - Confirm that `Embedded N/N` reflects actual durable writes to memory storage.
   - Verify the number of unique accepted candidates increased from the prior cycle.

7. **Report outcome as action, not observation.**
   - Log the exact number of junk facts removed, the new queue size, and the resulting embed count.
   - If remediation was impossible, escalate rather than leaving a success line.

8. **Record the lesson.**
   - If a novel livelock signature or false-success pattern is found, add it to this skill.
   - Reference the fix that resolved the original issue: `a6c3d2a` added content-length filtering plus oldest-first sorting.

## Critical Rules
- **Detection without action is failure.** A health check that identifies a problem but returns to normal operation without fixing it is not a success. It is a missed failure.
- **Never log `Embedded 0/N` as a success.** If zero items are embedded, the log line must be treated as an anomaly and must trigger remediation routing.
- **Always run the livelock signature check first.** Repeated `Embedded 0/N` lines mean the pipeline is stuck; do not attempt normal embedding until the queue has been inspected.
- **Do not let short junk facts own the head of the candidate queue.** Apply a content-length filter and an oldest-first sort before `shouldEmbed` is invoked.
- **A changed candidate set is a precondition for a healthy embed cycle.** If two consecutive cycles produce the same candidate population, force a queue rotation or halt.
- **Every remediation run must end with an action line**, not just an observation line: state what was removed, what was sorted, and what was written.
- **When a new failure signature is discovered, fold it into the skill immediately.** The skills engine must never carry the same failure pattern into the next run unmapped.

## References
- Fix commit: `a6c3d2a` — content-length filter + oldest-first sort resolved embed livelock.
- Underlying principle: detection-without-action-is-failure.
- Suggested future enhancement: automatic livelock signature detection on repeated `Embedded 0/N` log lines.