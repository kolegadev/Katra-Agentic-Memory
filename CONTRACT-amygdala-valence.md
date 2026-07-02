# CONTRACT: Amygdala — Rapid Valence Tagger + Emotional Memory Modulation

## Goal
Add real-time emotional processing at event ingestion. Currently Katra only assigns emotional signatures during nightly sleep consolidation — hours after events. The amygdala proxy tags events *during* ingestion with valence/arousal, modulates memory encoding by emotion, and boosts high-arousal events in processing priority.

## From Research
"Rapid Valence Tagger: Lightweight regex/sentiment classifier. Runs during episodic event ingestion. Tags each event: valence (-1 to +1), arousal (0 to 1). Fast — no LLM call, pure classifier."
"High-arousal events → stronger embedding weights, skip decay curve, resist forgetting."

## Boundaries
- MODIFY: `episodic-event-manager.ts` — add tagging in `createEvent()`
- CREATE: `server/src/services/processing/valence-tagger.ts` — lightweight classifier
- DO NOT TOUCH: LLM extraction, background processor, existing event schema

## Success Criteria
1. `ValenceTagger.tagEvent(content)` returns `{ valence: -1..1, arousal: 0..1 }` using keyword heuristics
2. Tagging runs during `createEvent()` — stored in `metadata.emotional_tags`
3. High-arousal events (arousal > 0.7) get `metadata.priority: 'high'` for background processor
4. Negative-valence events (valence < -0.3) get `metadata.caution: true`
5. High-arousal events get `decay_resistant: true` metadata — checked by MemoryDecayService
6. Zero LLM calls — pure keyword/regex classifier, <1ms per event
