# CONTRACT: Attention Gate — RL-Guided Triage Override

## Goal
Replace the hardcoded `SYSTEM_EVENT_TYPES` triage check with RL-guided salience-based overrides. The hardcoded check remains as a safe default, but high-salience system events can be promoted to full extraction and low-salience user events can be demoted to lightweight — with both decisions learned through RL outcomes.

## Design
- Default: system events → lightweight, user events → full (existing behavior)
- Override: salience score from Amygdala tagger + SalienceService can flip the decision
- RL learns: which overrides produce better outcomes (quality vs cost)
- Safety: never override to "full" for heartbeat_action or autonomous_action (pure system noise)

## Boundaries
- MODIFY: `background-processor.ts` — add salience check before triage decision
- MODIFY: `salience-service.ts` — expose quick salience scoring for single events
- DO NOT REMOVE: SYSTEM_EVENT_TYPES default — it's the safety floor

## Success Criteria
1. Events with emotional_tags.arousal > 0.7 OR caution:true get promoted to full extraction regardless of type
2. Conversation events with arousal < 0.15 and no caution get demoted to lightweight
3. Each override decision calls selectAction() and records outcome
4. Hardcoded check still applies to heartbeat_action and autonomous_action (never promote pure system noise)
