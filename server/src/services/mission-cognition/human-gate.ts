/**
 * Human-gate vocabulary.
 *
 * The delta schema's set is canonical: none | required_before_merge |
 * required_before_effect. The MCP surface historically accepted a vaguer
 * none | approval | review, and only `none` is common to both, so every gated
 * delta was invalid on one side or the other. The surface now accepts both and
 * normalises here, so the stored contract keeps one vocabulary and old callers
 * keep working. (the generator, 2026-10-23.)
 */
export const HUMAN_GATES = ['none', 'required_before_merge', 'required_before_effect'] as const;
export type HumanGate = (typeof HUMAN_GATES)[number];

export const HUMAN_GATE_ALIASES: Readonly<Record<string, HumanGate>> = {
  none: 'none',
  approval: 'required_before_merge',
  review: 'required_before_effect',
  required_before_merge: 'required_before_merge',
  required_before_effect: 'required_before_effect',
};

export function normaliseHumanGate(value: unknown): HumanGate | undefined {
  if (value === undefined || value === null) return undefined;
  const key = String(value).trim().toLowerCase();
  if (!key) return undefined;
  const mapped = HUMAN_GATE_ALIASES[key];
  if (!mapped) {
    throw new Error(
      `unknown human_gate ${JSON.stringify(value)}; allowed: ` +
        `${Object.keys(HUMAN_GATE_ALIASES).join('|')}`,
    );
  }
  return mapped;
}
