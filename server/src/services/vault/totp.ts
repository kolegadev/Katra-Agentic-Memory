/**
 * Katra Vault — TOTP mechanism (F9, RFC 6238)
 *
 * Pure RFC 6238 time-based one-time passwords over HMAC-SHA1 with
 * `node:crypto` only (zero new dependencies), plus RFC 4648 base32
 * helpers and otpauth URI construction for enrollment QRs.
 *
 * Reproduces the published RFC 6238 Appendix B SHA1 test-vector table
 * exactly (secret ASCII "12345678901234567890" →
 * base32 "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 8 digits, step 30).
 *
 * Replay guard: `verifyTotp({ lastCounter })` rejects any code whose
 * counter is <= the last successfully validated counter — reuse within the
 * same step AND any older counter are both refused.
 *
 * No secret, code, or URI is ever logged here; these are pure functions.
 */

import { createHmac, randomBytes } from 'node:crypto';

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULT_STEP = 30; // seconds
const DEFAULT_DIGITS = 6;
const DEFAULT_WINDOW = 1; // ±1 step
const DEFAULT_ISSUER = 'Katra';
const DEFAULT_SECRET_BYTES = 20; // 160-bit secrets (RFC 4226 recommendation)

// ── Base32 (RFC 4648, no padding on encode) ───────────────────────────────

function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decode base32 (RFC 4648). Tolerates lowercase and optional '=' padding. */
function base32Decode(input: string): Uint8Array {
  const cleaned = input
    .toUpperCase()
    .replace(/=+$/, '')
    .replace(/[\s-]/g, '');
  if (cleaned.length === 0) {
    throw new Error('vault: empty base32 secret');
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of cleaned) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('vault: invalid base32 secret');
    buffer = (buffer << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(bytes);
}

// ── Public API (contract F9 exact interfaces) ─────────────────────────────

/**
 * Generate a fresh TOTP secret: `bytes` random bytes (default 20) as an
 * uppercase RFC 4648 base32 string with NO padding.
 */
export function generateTotpSecret(bytes?: number): string {
  const length =
    bytes === undefined ? DEFAULT_SECRET_BYTES : Math.max(1, Math.floor(bytes));
  return base32Encode(randomBytes(length));
}

export interface TotpCodeOptions {
  /** Unix time in SECONDS (default Date.now()/1000). */
  time?: number;
  /** Step in seconds (default 30). */
  step?: number;
  /** Code length in digits (default 6). */
  digits?: number;
}

/**
 * RFC 6238 TOTP over HMAC-SHA1: code for the counter floor(time/step),
 * zero-padded to `digits` digits.
 */
export function totpCode(secretBase32: string, opts: TotpCodeOptions = {}): string {
  const step = opts.step === undefined ? DEFAULT_STEP : opts.step;
  const digits = opts.digits === undefined ? DEFAULT_DIGITS : opts.digits;
  const time = resolveTime(opts.time);
  return hotp(secretBase32, Math.floor(time / step), digits);
}

export interface TotpVerifyOptions {
  /** Unix time in SECONDS (default Date.now()/1000). */
  time?: number;
  /** Accepted drift in steps either side of the current counter (default 1). */
  window?: number;
  step?: number;
  digits?: number;
  /** Replay guard: reject when the matched counter is <= lastCounter. */
  lastCounter?: number;
}

export interface TotpVerifyResult {
  ok: boolean;
  /** The counter whose code matched (== floor(time/step) for a current
   *  code); the nominal counter floor(time/step) when nothing matched. */
  counter: number;
}

/**
 * Verify a code against the secret within ±`window` steps of the current
 * counter. With `lastCounter` set, any matched counter <= lastCounter is
 * rejected (replay within the same step AND older counters).
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  opts: TotpVerifyOptions = {},
): TotpVerifyResult {
  const step = opts.step === undefined ? DEFAULT_STEP : opts.step;
  const digits = opts.digits === undefined ? DEFAULT_DIGITS : opts.digits;
  const time = resolveTime(opts.time);
  const nominal = Math.floor(time / step);
  const window =
    opts.window === undefined
      ? DEFAULT_WINDOW
      : Math.max(0, Math.floor(opts.window));

  // Format sanity: digits only, at most `digits` digits (leading-zero forms
  // like "07081804" compare numerically, so "7081804" is the same code).
  const trimmed = typeof code === 'string' ? code.trim() : '';
  if (!/^\d+$/.test(trimmed) || trimmed.length > digits) {
    return { ok: false, counter: nominal };
  }
  const submitted = parseInt(trimmed, 10);

  // Oldest candidate first: the earliest valid window step wins, which makes
  // the replay guard deterministic (a stale-but-valid code is never picked
  // over the current one).
  for (let counter = nominal - window; counter <= nominal + window; counter++) {
    if (hotpInt(secretBase32, counter, digits) !== submitted) continue;
    if (opts.lastCounter !== undefined && counter <= opts.lastCounter) {
      return { ok: false, counter: nominal };
    }
    return { ok: true, counter };
  }
  return { ok: false, counter: nominal };
}

/**
 * Enrollment QR URI, exactly:
 * `otpauth://totp/Katra:<identity>?secret=<b32>&issuer=<issuer|'Katra'>
 *  &algorithm=SHA1&digits=6&period=30`
 */
export function otpauthUri(
  identity: string,
  secretBase32: string,
  issuer?: string,
): string {
  const name = issuer === undefined || issuer.length === 0 ? DEFAULT_ISSUER : issuer;
  return (
    `otpauth://totp/${name}:${identity}` +
    `?secret=${secretBase32}` +
    `&issuer=${name}` +
    `&algorithm=SHA1` +
    `&digits=6` +
    `&period=30`
  );
}

// ── Internals ──────────────────────────────────────────────────────────────

function resolveTime(time: number | undefined): number {
  if (time !== undefined && Number.isFinite(time) && time >= 0) return time;
  return Date.now() / 1000;
}

/** HOTP (RFC 4226) dynamic truncation over HMAC-SHA1, numeric form. */
function hotpInt(secretBase32: string, counter: number, digits: number): number {
  const key = base32Decode(secretBase32);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(Math.max(0, counter)));
  const digest = createHmac('sha1', key).update(counterBuf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const bin =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return bin % Math.pow(10, digits);
}

/** HOTP as a zero-padded string of exactly `digits` digits. */
function hotp(secretBase32: string, counter: number, digits: number): string {
  const value = hotpInt(secretBase32, counter, digits);
  return value.toString().padStart(digits, '0');
}
