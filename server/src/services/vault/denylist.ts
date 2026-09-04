/**
 * Katra Vault no-LLM guarantees (F5) — pipeline collection denylist.
 *
 * Makes it structurally impossible for vault material to reach an LLM: every
 * memory-processing read path that can feed documents to an LLM call consults
 * this module IMMEDIATELY BEFORE reading a named collection. Exact collection
 * names only — no prefix/tenant variants.
 *
 * Source of truth: docs/katra-vault-design.md §7.1 (objective O3, guard 1 of 3).
 */

export const VAULT_DENYLISTED_COLLECTIONS: readonly string[] = [
  'secrets',
  'vault_approvals',
  'vault_audit',
  'auth_sessions',
  'auth_totp',
];

/** Exact-match check: is this collection denylisted from LLM-facing reads? */
export function isVaultDenylisted(collection: string): boolean {
  return VAULT_DENYLISTED_COLLECTIONS.includes(collection);
}

/**
 * Read gate for LLM-facing pipeline reads. Synchronous, no DB calls.
 *
 * Throws when a denylisted collection is about to be read by a processing
 * path; returns undefined otherwise (behavior for allowed collections is
 * byte-for-byte unchanged).
 */
export function assertVaultCollectionAllowed(collection: string, context: string): void {
  if (isVaultDenylisted(collection)) {
    throw new Error(`vault: denylisted collection '${collection}' blocked in ${context}`);
  }
}
