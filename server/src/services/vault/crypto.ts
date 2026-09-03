/**
 * Katra Vault — envelope-encryption core (F1)
 *
 * `node:crypto` only (zero new dependencies). AES-256-GCM everywhere, with
 * a per-scope key-encryption key (KEK) derived from `KATRA_VAULT_MASTER_KEY`
 * via HKDF-SHA256, and a per-secret data-encryption key (DEK) that is
 * wrapped by the scope KEK and carried on the envelope.
 *
 * Design (docs/katra-vault-design.md §4/§5, locked decision 1):
 *
 * - master key  = 32 random bytes as 64 hex chars (`KATRA_VAULT_MASTER_KEY`).
 * - scope KEK   = HKDF-SHA256(master key, salt = "<kek_version>",
 *                 info = "vault:<scope>", 32 bytes) where scope is
 *                 "user:<user_id>" | "shared:<shared_id>". The kek_version
 *                 is mixed in as the HKDF salt so key material for two
 *                 versions can never coincide — a future rotation bumps the
 *                 version and re-wraps DEKs while keeping ciphertexts.
 * - value       = AES-256-GCM(DEK, plaintext) — fresh random 12-byte IV and
 *                 auth tag per encryption, never reused.
 * - DEK (32 B)  = AES-256-GCM(scope KEK, DEK) — wrapped on the envelope.
 *
 * Partition isolation is crypto-enforced: opening under a different scope or
 * a different master key derives a different KEK, the wrapped DEK fails GCM
 * authentication, and `openSecret` throws — never returns garbage.
 *
 * All thrown errors are `Error` instances whose message contains 'vault'
 * (callers map failures to 4xx/5xx without leaking details). No key
 * material, plaintext, or envelope content is ever logged here.
 */

import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from 'node:crypto';

const ALG = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256 / DEK length
const IV_BYTES = 12; // GCM standard nonce length
const KEK_INFO_PREFIX = 'vault:';
const DEFAULT_KEK_VERSION = 1;
const MASTER_KEY_HEX_RE = /^[0-9a-f]{64}$/i;

/** AES-256-GCM result: all strings are base64. */
export interface GcmParts {
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface VaultEnvelope extends GcmParts {
  alg: 'aes-256-gcm';
  kek_version: number;
  // DEK wrapped by the scope KEK (AES-256-GCM), separate iv/tag:
  dek_iv: string;
  dek_tag: string;
  dek_wrapped: string; // base64 ciphertext of the 32-byte DEK
}

function vaultError(reason: string): Error {
  return new Error(`vault: ${reason}`);
}

/** Encrypt `plain` with a 32-byte key; fresh random IV per call. */
function encryptWithKey(plain: Buffer, key: Buffer): GcmParts {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/**
 * Decrypt `parts` with a 32-byte key. Any GCM authentication failure,
 * malformed base64, or missing field throws a vault error — never returns
 * garbage.
 */
function decryptWithKey(parts: GcmParts, key: Buffer): Buffer {
  try {
    const iv = Buffer.from(parts.iv, 'base64');
    const tag = Buffer.from(parts.tag, 'base64');
    const ciphertext = Buffer.from(parts.ciphertext, 'base64');
    const decipher = createDecipheriv(ALG, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw vaultError('decryption failed (integrity or format error)');
  }
}

/**
 * 32 random bytes -> 64 lowercase hex chars (the `KATRA_VAULT_MASTER_KEY`
 * format). Generate once per install — never per secret.
 */
export function generateMasterKey(): string {
  return randomBytes(KEY_BYTES).toString('hex');
}

/** True iff `hex` is exactly 64 hex characters (case-insensitive). */
export function validateMasterKey(hex: string): boolean {
  return typeof hex === 'string' && MASTER_KEY_HEX_RE.test(hex);
}

/**
 * Derive the 32-byte scope KEK: HKDF-SHA256 over the master key with
 * info exactly `"vault:" + scope` and the kek_version as HKDF salt
 * (default 1). Deterministic for identical inputs; differs across scopes
 * and across kek_versions.
 */
export function deriveScopeKek(
  masterKeyHex: string,
  scope: string,
  kekVersion?: number,
): Buffer {
  const version = kekVersion === undefined ? DEFAULT_KEK_VERSION : kekVersion;
  // hkdfSync yields an ArrayBuffer without an encoding; wrap it so callers
  // receive a real Buffer (contract: Buffer).
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(masterKeyHex, 'hex'),
      Buffer.from(String(version), 'utf8'),
      Buffer.from(`${KEK_INFO_PREFIX}${scope}`, 'utf8'),
      KEY_BYTES,
    ),
  );
}

/** 32 random bytes — one fresh DEK per sealed secret. */
export function generateDek(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Encrypt a UTF-8 string under the DEK (AES-256-GCM, random IV). */
export function encryptValue(plaintext: string, dek: Buffer): GcmParts {
  return encryptWithKey(Buffer.from(plaintext, 'utf8'), dek);
}

/**
 * Decrypt `parts` under the DEK back to a UTF-8 string. Throws a vault
 * error on any tamper / integrity failure.
 */
export function decryptValue(parts: GcmParts, dek: Buffer): string {
  return decryptWithKey(parts, dek).toString('utf8');
}

/** Wrap the 32-byte DEK under the scope KEK (AES-256-GCM, random IV). */
export function wrapDek(
  dek: Buffer,
  kek: Buffer,
): { dek_iv: string; dek_tag: string; dek_wrapped: string } {
  const wrapped = encryptWithKey(dek, kek);
  return {
    dek_iv: wrapped.iv,
    dek_tag: wrapped.tag,
    dek_wrapped: wrapped.ciphertext,
  };
}

/**
 * Unwrap the DEK with the scope KEK. Throws a vault error on tamper or a
 * wrong KEK (wrong scope / wrong master key), and on any non-32-byte
 * result.
 */
export function unwrapDek(
  w: { dek_iv: string; dek_tag: string; dek_wrapped: string },
  kek: Buffer,
): Buffer {
  const dek = decryptWithKey(
    { iv: w.dek_iv, tag: w.dek_tag, ciphertext: w.dek_wrapped },
    kek,
  );
  if (dek.length !== KEY_BYTES) {
    throw vaultError('unwrapped DEK has an invalid length');
  }
  return dek;
}

/**
 * Seal a secret value for a scope: derive the scope KEK, generate a fresh
 * DEK, encrypt the value with the DEK, wrap the DEK with the KEK. The
 * `kek_version` used is stored on the envelope.
 */
export function sealSecret(
  plaintext: string,
  scope: string,
  masterKeyHex: string,
  kekVersion?: number,
): VaultEnvelope {
  const version = kekVersion === undefined ? DEFAULT_KEK_VERSION : kekVersion;
  const kek = deriveScopeKek(masterKeyHex, scope, version);
  const dek = generateDek();
  const parts = encryptValue(plaintext, dek);
  const wrapped = wrapDek(dek, kek);
  return {
    alg: ALG as 'aes-256-gcm',
    kek_version: version,
    iv: parts.iv,
    tag: parts.tag,
    ciphertext: parts.ciphertext,
    dek_iv: wrapped.dek_iv,
    dek_tag: wrapped.dek_tag,
    dek_wrapped: wrapped.dek_wrapped,
  };
}

/**
 * Open a sealed secret: re-derive the KEK for the given scope and the
 * envelope's stored kek_version, unwrap the DEK, decrypt the value.
 *
 * Throws a vault error on any tamper, a wrong scope, or a different master
 * key (crypto-enforced partition isolation — spec §5, O1/O2). Malformed
 * envelopes (wrong alg / missing kek_version) also throw.
 */
export function openSecret(
  envelope: VaultEnvelope,
  scope: string,
  masterKeyHex: string,
): string {
  if (
    !envelope ||
    envelope.alg !== ALG ||
    typeof envelope.kek_version !== 'number' ||
    !Number.isInteger(envelope.kek_version) ||
    envelope.kek_version < 1
  ) {
    throw vaultError('unsupported envelope format');
  }
  // The stored version is read from the envelope, never guessed.
  const kek = deriveScopeKek(masterKeyHex, scope, envelope.kek_version);
  const dek = unwrapDek(envelope, kek);
  return decryptValue(envelope, dek);
}
