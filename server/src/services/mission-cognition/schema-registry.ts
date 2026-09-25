// Schema registry for the long-horizon cognitive control contracts.
// Loads the six draft-2020-12 schemas and validates persisted/tool payloads.
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
    errors: (v.errors ?? []).map(e => `${e.instancePath || '/'} ${e.message ?? 'invalid'}`),
  };
}
