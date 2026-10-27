/**
 * Authority matrix — the scope table and pattern classifier.
 *
 * This is a faithful port of scripts/python/authority_matrix.py (137 lines, in the repo
 * since the autonomous-loop work), promoted to the TypeScript server as the single source
 * of truth. The three scopes, their patterns and their instructions are preserved exactly.
 *
 * IMPORTANT — what this classifier IS and IS NOT:
 *
 *   It IS a heuristic that maps a free-text subject onto one of three treatment classes.
 *   It IS NOT a security boundary. It matches substrings, so it can be talked around by
 *   phrasing. Never treat `inferAuthority()` as the last gate before an externally visible
 *   effect — use it to *suggest* a class, and require explicit declaration for anything
 *   consequential. `authority.ts` enforces that ordering.
 *
 * Order matters: first match wins, so the self-evolution scope is checked before the
 * user-project scope (the word "katra" appears in both kinds of subject).
 */

import type { Autonomy, ScopeRule } from './types.js';

/**
 * The scope table.
 *
 * Ported verbatim from the Python SCOPE_MATRIX, with `mandatory_action` and
 * `failure_condition` retained because downstream instructions quote them verbatim.
 */
export const SCOPE_MATRIX: readonly ScopeRule[] = [
  {
    name: 'Self-Evolution',
    patterns: [
      'katra',
      'opencode_extractor',
      'kolega-code-extractor',
      'bridge code',
      'empty-result filter',
      'reflection',
      'embedding',
      'memory-manager',
      'background-processor',
      'sleep consolidation',
      'adaptive-heartbeat',
      'agent-executor',
      'salience',
      'neural-link',
    ],
    autonomy: 'autonomous',
    mandatoryAction:
      'Run the Autonomous Loop Protocol. Execute immediately. Stalling is a failure condition.',
    failureCondition: 'Stopping to ask for permission on Scope A operations.',
  },
  {
    name: 'User Projects',
    patterns: [
      'gh-hygiene',
      'poly-meta',
      'microsaas',
      'deposit-back',
      'blasted',
      'github.com/kolegadev',
    ],
    autonomy: 'gated',
    mandatoryAction:
      'Investigate and report findings. Do NOT modify without explicit user approval.',
    failureCondition: 'Modifying user project files without authorization.',
  },
  {
    name: 'System Config',
    patterns: [
      'launchd',
      'systemd',
      'nginx',
      'crontab',
      '.bashrc',
      '.zshrc',
      'docker-compose',
      'firewall',
      'ssh',
      'sudo',
    ],
    autonomy: 'cautious',
    mandatoryAction:
      'Inspect existing state. Preserve/merge by default. Only change if directly serving Scope A.',
    failureCondition:
      'Overwriting system config without inspection or when not serving Scope A.',
  },
] as const;

/**
 * The default rule for anything that matches nothing.
 *
 * DENY BY DEFAULT. The Python original also defaults to GATED; that property is
 * load-bearing and must not be weakened. An unrecognised subject is assumed to be
 * someone's project, not Katra's own business.
 */
export const UNKNOWN_SCOPE: ScopeRule = {
  name: 'Unknown',
  patterns: [],
  autonomy: 'gated',
  mandatoryAction: 'Investigate and report. Do not modify.',
  failureCondition: 'Acting on unknown entities without reporting.',
};

/**
 * Classify a subject against the scope table by substring match.
 * Returns the matched rule, or UNKNOWN_SCOPE. First match wins.
 */
export function matchScope(subject: string, thread = ''): ScopeRule {
  const combined = `${subject} ${thread}`.toLowerCase();
  for (const rule of SCOPE_MATRIX) {
    for (const pattern of rule.patterns) {
      if (combined.includes(pattern)) return rule;
    }
  }
  return UNKNOWN_SCOPE;
}

/** True when this autonomy level may act without a gate. Only 'autonomous' does. */
export function isAutonomous(autonomy: Autonomy): boolean {
  return autonomy === 'autonomous';
}
