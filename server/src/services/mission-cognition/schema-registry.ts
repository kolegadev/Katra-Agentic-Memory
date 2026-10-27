// Schema registry for the long-horizon cognitive control contracts.
// Loads the draft-2020-12 schemas (six control-plane contracts plus the
// ITER-5 salience trace) and validates persisted/tool payloads.
// Part of the no-publish branch feat/cognitive-control-local.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import type { ValidateFunction } from 'ajv';

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'schemas');

export const SCHEMA_IDS = {
  missionState: 'https://katra.dev/schemas/mission-state.schema.json',
  stateDelta: 'https://katra.dev/schemas/state-delta.schema.json',
  epistemicEntry: 'https://katra.dev/schemas/epistemic-entry.schema.json',
  cognitiveBaton: 'https://katra.dev/schemas/cognitive-baton.schema.json',
  cognitiveWorkItem: 'https://katra.dev/schemas/cognitive-work-item.schema.json',
  agentCognitiveProfile: 'https://katra.dev/schemas/agent-cognitive-profile.schema.json',
  // ITER-5: the private, mission-scoped salience trace. It is registered here
  // rather than behind a second validator because it is the same class of
  // mission-scoped artifact as the six above, and the shared Ajv2020 instance
  // already carries the draft-2020-12 / formats configuration it needs.
  salienceTrace: 'https://katra.dev/schemas/salience-trace.schema.json',
  // ITER-6: the hypothesis seed the imagination engine produces and the
  // quality-diversity archive stores. Validated before every store, so a seed
  // that cannot answer "what, why, how would we know, and on what evidence"
  // never reaches the collection.
  ideaSeed: 'https://katra.dev/schemas/idea-seed.schema.json',
  // ITER-7: the SANITISED Creative Baton. The compiler validates it before it
  // is written, and the promoter RE-validates the stored document before it
  // stamps a shared scope, so a tampered payload can neither be stored nor
  // promoted.
  creativeBaton: 'https://katra.dev/schemas/creative-baton.schema.json',
  // ITER-8: the bounded inheritance envelope a spawned cognitive agent
  // receives. It is validated before it is stored and re-validated before every
  // read for use, and it is CLOSED (`additionalProperties: false` everywhere),
  // so a field the creator never wrote fails even when the policy hash was
  // recomputed.
  inheritanceEnvelope: 'https://katra.dev/schemas/inheritance-envelope.schema.json',
} as const;

let _ajv: Ajv2020 | null = null;
const _validators = new Map<string, ValidateFunction>();

export function getValidator(schemaId: string): ValidateFunction {
  if (!_ajv) {
    // strict:false — the draft schemas are design contracts, not runtime stubs;
    // we validate structure, not Ajv's schema-authoring style.
    _ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(_ajv);
    for (const file of readdirSync(SCHEMA_DIR)) {
      if (!file.endsWith('.schema.json')) continue;
      const schema = JSON.parse(readFileSync(join(SCHEMA_DIR, file), 'utf-8'));
      _ajv.addSchema(schema); // registers by $id, resolves cross-file $refs
    }
  }
  let v = _validators.get(schemaId);
  if (!v) {
    v = _ajv.getSchema(schemaId);
    if (!v) throw new Error(`schema not registered: ${schemaId}`);
    _validators.set(schemaId, v);
  }
  return v;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateAgainst(schemaId: string, doc: unknown): ValidationResult {
  const v = getValidator(schemaId);
  const valid = v(doc);
  if (valid) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: (v.errors ?? []).map(e => {
      const base = `${e.instancePath || '/'} ${e.message ?? 'invalid'}`;
      // Ajv already holds the allowed set for an enum failure; without it the
      // caller must open the schema to learn the valid values. Every closed
      // enum in this plane (delta_type, entry_type, status, ...) reported
      // "must be equal to one of the allowed values" and named none of them —
      // reported by the generator, 2026-10-21.
      const allowed = (e.params as { allowedValues?: unknown[] } | undefined)?.allowedValues;
      return e.keyword === 'enum' && Array.isArray(allowed)
        ? `${base} (allowed: ${allowed.map(v => String(v)).join('|')})`
        : base;
    }),
  };
}
