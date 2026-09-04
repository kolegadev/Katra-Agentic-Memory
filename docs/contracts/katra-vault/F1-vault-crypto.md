# CONTRACT — F1: Katra Vault core crypto (envelope encryption)

Source of truth: `docs/katra-vault-design.md` §4, §5 (locked decisions 1–2).

## Goal
An envelope-encryption module using **`node:crypto` only** (zero new npm dependencies):
AES-256-GCM for secret values, per-scope KEKs derived from `KATRA_VAULT_MASTER_KEY`
via HKDF-SHA256, per-secret random DEKs, DEK wrapped by the scope KEK, `kek_version`
carried for future rotation.

## Boundaries — MUST NOT touch
- `server/src/routes/**`, `server/src/mcp-server.ts`, `dashboard/**`
- `server/src/services/memory/**`, `server/src/services/processing/**`,
  `server/src/services/orchestration/**`, `server/src/index.ts`
- `server/package.json` (no dependency changes)
- Existing `server/tests/**` files (only ADD tests)

## Files this feature may create/modify
- NEW `server/src/services/vault/crypto.ts` (the module)
- NEW `server/tests/unit/vault/crypto.test.ts`
- MODIFY `install.sh`: generate `KATRA_VAULT_MASTER_KEY` (64 hex chars) into `.env`
  if absent — idempotent, must never overwrite an existing value.
- MODIFY `.env.example`: add commented `#KATRA_VAULT_MASTER_KEY=` line near the
  other KATRA_* keys.

## Interfaces (exact signatures — implement these, no more, no less)

```ts
// AES-256-GCM result: all strings are base64.
export interface GcmParts { iv: string; tag: string; ciphertext: string; }

export interface VaultEnvelope extends GcmParts {
  alg: 'aes-256-gcm';
  kek_version: number;
  // DEK wrapped by the scope KEK (AES-256-GCM), separate iv/tag:
  dek_iv: string;
  dek_tag: string;
  dek_wrapped: string; // base64 ciphertext of the 32-byte DEK
}

export function generateMasterKey(): string;            // 32 random bytes -> 64 hex
export function validateMasterKey(hex: string): boolean; // exactly 64 hex chars
export function deriveScopeKek(masterKeyHex: string, scope: string, kekVersion?: number): Buffer; // default 1
export function generateDek(): Buffer;                  // 32 random bytes
export function encryptValue(plaintext: string, dek: Buffer): GcmParts;
export function decryptValue(parts: GcmParts, dek: Buffer): string; // throws on tamper
export function wrapDek(dek: Buffer, kek: Buffer): { dek_iv: string; dek_tag: string; dek_wrapped: string };
export function unwrapDek(w: { dek_iv: string; dek_tag: string; dek_wrapped: string }, kek: Buffer): Buffer; // throws on tamper / wrong KEK
export function sealSecret(plaintext: string, scope: string, masterKeyHex: string, kekVersion?: number): VaultEnvelope;
export function openSecret(envelope: VaultEnvelope, scope: string, masterKeyHex: string): string; // throws on wrong scope/tamper
```

Semantics (from the spec, must hold):
- `scope` is `"user:<user_id>"` or `"shared:<shared_id>"`; KEK info string is
  exactly `"vault:" + scope`; HKDF-SHA256 output length 32 bytes.
- GCM IVs are 12 random bytes per encryption (never reuse).
- `sealSecret` derives the scope KEK, generates a fresh DEK, encrypts the value
  with the DEK, wraps the DEK with the KEK; `kek_version` stored on the envelope.
- `openSecret` re-derives the KEK for the given scope and version, unwraps the
  DEK, decrypts the value. Any GCM auth failure (value or wrapped DEK) must
  throw (never return garbage).
- `openSecret` with a different scope or different master key MUST throw
  (crypto-enforced partition isolation — spec §5, O1/O2).

## Success criteria (all must pass)
1. Round-trip `openSecret(sealSecret(x, s, mk)) === x` for: ASCII, unicode
   (emoji + CJK), empty string, 10 KB payload.
2. Tamper detection: flipping any single byte of `ciphertext`, `tag`, `iv`,
   `dek_wrapped`, `dek_tag`, or `dek_iv` makes `openSecret` throw.
3. Scope isolation: envelope sealed for `user:lilly` throws when opened with
   scope `user:shoshin` (same master key).
4. Master-key isolation: opening with a different master key throws.
5. Non-determinism + determinism: two seals of the same value produce
   different envelopes but both open to the same plaintext; `deriveScopeKek`
   is deterministic for identical inputs and differs across scopes.
6. `generateMasterKey()` returns 64 hex chars; `validateMasterKey` accepts it,
   rejects wrong lengths and non-hex.
7. `kek_version`: envelope carries the version; `openSecret` honors it (a
   future version bump path is at least represented by the parameter — the
   stored version is read from the envelope, not guessed).
8. `server/package.json` unchanged (no new deps — `node:crypto` only).

## Acceptance command
```
cd server && npx vitest run tests/unit/vault/ && npm test
```
- `tests/unit/vault/crypto.test.ts` fully green.
- Full suite `npm test`: **zero regression** — the same tests that pass on
  `main` must pass after this change. If anything outside the new file breaks,
  the feature FAILS.

## Implementation notes
- Use `import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, createHash } from 'node:crypto'` (Node >= 20).
- Errors must be thrown as `Error` with messages containing `'vault'` (helps
  later route code map failures without leaking details).
- No logging of key material, plaintext, or envelope contents.
