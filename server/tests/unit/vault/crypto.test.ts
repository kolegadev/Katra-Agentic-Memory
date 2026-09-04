/**
 * Unit tests: Katra Vault envelope-encryption core (F1)
 *
 * Pure node:crypto suite, DB-free. Covers every contract success criterion:
 * round-trips (ASCII / unicode / empty / 10 KB), single-byte tamper
 * detection across all six envelope fields, scope isolation, master-key
 * isolation, seal non-determinism + KEK determinism, master-key generation
 * / validation, and kek_version handling.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveScopeKek,
  decryptValue,
  encryptValue,
  generateDek,
  generateMasterKey,
  openSecret,
  sealSecret,
  unwrapDek,
  validateMasterKey,
  wrapDek,
} from '../../../src/services/vault/crypto.js';
import type { GcmParts, VaultEnvelope } from '../../../src/services/vault/crypto.js';

const MK = generateMasterKey();
const SCOPE = 'user:lilly';
const SECRET = 'agentmail-api-key: sk-live-4f9c2b7a1e8d3c5f6a0b9d8e7c6f5a4b3c2d1e0f';

function expectVaultError(fn: () => unknown): void {
  expect(fn).toThrow(expect.objectContaining({ message: expect.stringContaining('vault') }));
}

/** Flip one byte of a base64 string (decode → flip → re-encode). */
function flipOneByte(b64: string): string {
  const buf = Buffer.from(b64, 'base64');
  expect(buf.length).toBeGreaterThan(0);
  buf[0] = buf[0] ^ 0xff;
  return buf.toString('base64');
}

describe('round-trip: openSecret(sealSecret(x)) === x', () => {
  it('round-trips ASCII', () => {
    expect(openSecret(sealSecret(SECRET, SCOPE, MK), SCOPE, MK)).toBe(SECRET);
  });

  it('round-trips unicode (emoji + CJK)', () => {
    const value = '🔐 Katra vault 🔑 秘密の金庫 保密资料 vault-ключ 🔒';
    expect(openSecret(sealSecret(value, SCOPE, MK), SCOPE, MK)).toBe(value);
  });

  it('round-trips the empty string', () => {
    expect(openSecret(sealSecret('', SCOPE, MK), SCOPE, MK)).toBe('');
  });

  it('round-trips a 10 KB payload', () => {
    const chunk = 'the quick brown fox jumps over the lazy dog — 敏捷的棕狐 0123456789\n';
    const payload = chunk.repeat(Math.ceil((10 * 1024) / chunk.length)).slice(0, 10 * 1024);
    expect(payload.length).toBe(10 * 1024);
    expect(openSecret(sealSecret(payload, SCOPE, MK), SCOPE, MK)).toBe(payload);
  });
});

describe('tamper detection — every envelope field is authenticated', () => {
  const env = sealSecret(SECRET, SCOPE, MK);

  it.each([
    ['ciphertext', (e: VaultEnvelope) => ({ ...e, ciphertext: flipOneByte(e.ciphertext) })],
    ['tag', (e: VaultEnvelope) => ({ ...e, tag: flipOneByte(e.tag) })],
    ['iv', (e: VaultEnvelope) => ({ ...e, iv: flipOneByte(e.iv) })],
    ['dek_wrapped', (e: VaultEnvelope) => ({ ...e, dek_wrapped: flipOneByte(e.dek_wrapped) })],
    ['dek_tag', (e: VaultEnvelope) => ({ ...e, dek_tag: flipOneByte(e.dek_tag) })],
    ['dek_iv', (e: VaultEnvelope) => ({ ...e, dek_iv: flipOneByte(e.dek_iv) })],
  ])('a single flipped byte in %s makes openSecret throw', (_field, tamper) => {
    expectVaultError(() => openSecret(tamper(env), SCOPE, MK));
  });

  it('also detects a flipped byte at the END of dek_wrapped', () => {
    const buf = Buffer.from(env.dek_wrapped, 'base64');
    buf[buf.length - 1] = buf[buf.length - 1] ^ 0xff;
    expectVaultError(() =>
      openSecret({ ...env, dek_wrapped: buf.toString('base64') }, SCOPE, MK),
    );
  });

  it('rejects envelopes with a wrong alg', () => {
    expectVaultError(() => openSecret({ ...env, alg: 'aes-128-gcm' as const }, SCOPE, MK));
  });

  it('rejects envelopes with a missing/non-numeric kek_version', () => {
    const { kek_version: _v, ...noVersion } = env;
    expectVaultError(() => openSecret(noVersion as VaultEnvelope, SCOPE, MK));
  });
});

describe('partition isolation (crypto-enforced)', () => {
  it('a secret sealed for user:lilly throws when opened with user:shoshin', () => {
    const env = sealSecret(SECRET, 'user:lilly', MK);
    expectVaultError(() => openSecret(env, 'user:shoshin', MK));
  });

  it('a shared secret throws when opened with a user scope (and vice versa)', () => {
    const env = sealSecret(SECRET, 'shared:my-team', MK);
    expectVaultError(() => openSecret(env, SCOPE, MK));
    expect(openSecret(env, 'shared:my-team', MK)).toBe(SECRET);
  });

  it('opening with a different master key throws', () => {
    const env = sealSecret(SECRET, SCOPE, MK);
    const otherMk = generateMasterKey();
    expect(otherMk).not.toBe(MK);
    expectVaultError(() => openSecret(env, SCOPE, otherMk));
  });
});

describe('non-determinism of seals, determinism of KEKs', () => {
  it('two seals of the same value produce different envelopes', () => {
    const a = sealSecret(SECRET, SCOPE, MK);
    const b = sealSecret(SECRET, SCOPE, MK);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
    expect(a.iv).not.toBe(b.iv);
    expect(a.dek_iv).not.toBe(b.dek_iv);
    expect(a.dek_wrapped).not.toBe(b.dek_wrapped);
  });

  it('both seals open to the same plaintext', () => {
    const a = sealSecret(SECRET, SCOPE, MK);
    const b = sealSecret(SECRET, SCOPE, MK);
    expect(openSecret(a, SCOPE, MK)).toBe(SECRET);
    expect(openSecret(b, SCOPE, MK)).toBe(SECRET);
  });

  it('deriveScopeKek is deterministic for identical inputs', () => {
    expect(deriveScopeKek(MK, SCOPE)).toEqual(deriveScopeKek(MK, SCOPE));
    expect(deriveScopeKek(MK, SCOPE)).toEqual(deriveScopeKek(MK, SCOPE, 1));
  });

  it('deriveScopeKek differs across scopes', () => {
    const user = deriveScopeKek(MK, 'user:lilly');
    const shoshin = deriveScopeKek(MK, 'user:shoshin');
    const shared = deriveScopeKek(MK, 'shared:my-team');
    expect(user).not.toEqual(shoshin);
    expect(user).not.toEqual(shared);
    expect(shoshin).not.toEqual(shared);
  });

  it('deriveScopeKek differs across kek_versions', () => {
    expect(deriveScopeKek(MK, SCOPE, 1)).not.toEqual(deriveScopeKek(MK, SCOPE, 2));
  });
});

describe('generateMasterKey / validateMasterKey', () => {
  it('generateMasterKey returns exactly 64 hex chars', () => {
    const mk = generateMasterKey();
    expect(mk).toMatch(/^[0-9a-f]{64}$/);
    expect(mk.length).toBe(64);
  });

  it('two generations differ', () => {
    expect(generateMasterKey()).not.toBe(generateMasterKey());
  });

  it('validateMasterKey accepts generated keys', () => {
    expect(validateMasterKey(generateMasterKey())).toBe(true);
    expect(validateMasterKey(MK)).toBe(true);
  });

  it('validateMasterKey rejects wrong lengths', () => {
    expect(validateMasterKey('a'.repeat(63))).toBe(false);
    expect(validateMasterKey('a'.repeat(65))).toBe(false);
    expect(validateMasterKey('a'.repeat(32))).toBe(false);
    expect(validateMasterKey('')).toBe(false);
  });

  it('validateMasterKey rejects non-hex', () => {
    expect(validateMasterKey('z'.repeat(64))).toBe(false);
    expect(validateMasterKey(`${'a'.repeat(63)}g`)).toBe(false);
    expect(validateMasterKey('0x' + 'a'.repeat(62))).toBe(false);
  });

  it('validateMasterKey rejects non-strings', () => {
    expect(validateMasterKey(undefined as unknown as string)).toBe(false);
    expect(validateMasterKey(null as unknown as string)).toBe(false);
  });
});

describe('kek_version handling', () => {
  it('sealSecret stores the default kek_version 1 on the envelope', () => {
    expect(sealSecret(SECRET, SCOPE, MK).kek_version).toBe(1);
  });

  it('sealSecret stores an explicit kek_version on the envelope', () => {
    expect(sealSecret(SECRET, SCOPE, MK, 2).kek_version).toBe(2);
  });

  it('openSecret reads the stored version from the envelope, not a guess', () => {
    const env = sealSecret(SECRET, SCOPE, MK, 1);
    expect(openSecret(env, SCOPE, MK)).toBe(SECRET);
    // Rewriting the stored version re-derives a different KEK (version is
    // bound into the derivation), so the seal must no longer open.
    expectVaultError(() => openSecret({ ...env, kek_version: 2 }, SCOPE, MK));
  });

  it('a seal made at kek_version 2 round-trips through openSecret', () => {
    const env = sealSecret(SECRET, SCOPE, MK, 2);
    expect(env.kek_version).toBe(2);
    expect(openSecret(env, SCOPE, MK)).toBe(SECRET);
  });

  it('v1 and v2 seals of the same value cannot cross-open', () => {
    const v1 = sealSecret(SECRET, SCOPE, MK, 1);
    const v2 = sealSecret(SECRET, SCOPE, MK, 2);
    expectVaultError(() => openSecret({ ...v1, kek_version: 2 }, SCOPE, MK));
    expectVaultError(() => openSecret({ ...v2, kek_version: 1 }, SCOPE, MK));
  });
});

describe('low-level primitives', () => {
  it('generateDek returns 32 random bytes, differing each call', () => {
    const a = generateDek();
    expect(a).toHaveLength(32);
    expect(generateDek()).not.toEqual(a);
  });

  it('encryptValue/decryptValue round-trip with per-call random IVs', () => {
    const dek = generateDek();
    const a: GcmParts = encryptValue(SECRET, dek);
    const b: GcmParts = encryptValue(SECRET, dek);
    expect(a.iv).not.toEqual(b.iv);
    expect(decryptValue(a, dek)).toBe(SECRET);
    expect(decryptValue(b, dek)).toBe(SECRET);
  });

  it('decryptValue throws on tampered parts', () => {
    const dek = generateDek();
    const parts = encryptValue(SECRET, dek);
    expectVaultError(() =>
      decryptValue({ ...parts, tag: flipOneByte(parts.tag) }, dek),
    );
  });

  it('decryptValue with the wrong DEK throws', () => {
    const parts = encryptValue(SECRET, generateDek());
    expectVaultError(() => decryptValue(parts, generateDek()));
  });

  it('wrapDek/unwrapDek round-trip a DEK under a KEK', () => {
    const dek = generateDek();
    const kek = deriveScopeKek(MK, SCOPE);
    const wrapped = wrapDek(dek, kek);
    expect(Buffer.from(wrapped.dek_wrapped, 'base64')).toHaveLength(32);
    expect(unwrapDek(wrapped, kek)).toEqual(dek);
  });

  it('unwrapDek throws on tampered wrap or the wrong KEK', () => {
    const dek = generateDek();
    const kek = deriveScopeKek(MK, SCOPE);
    const wrapped = wrapDek(dek, kek);
    expectVaultError(() =>
      unwrapDek({ ...wrapped, dek_tag: flipOneByte(wrapped.dek_tag) }, kek),
    );
    expectVaultError(() => unwrapDek(wrapped, deriveScopeKek(MK, 'user:shoshin')));
    expectVaultError(() => unwrapDek(wrapped, deriveScopeKek(generateMasterKey(), SCOPE)));
  });
});
