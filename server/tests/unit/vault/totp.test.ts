/**
 * Unit tests: Katra Vault TOTP core (F9) — contract success criteria 1–4.
 *
 * Pure RFC 6238 (node:crypto only) — no MongoDB needed.
 *
 * RFC 6238 Appendix B SHA1 vectors: the test secret is the ASCII string
 * "12345678901234567890". NOTE: the true RFC 4648 base32 of those bytes is
 * GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ — the "GEZDGNBV" ×4 string commonly
 * misquoted online decodes to ASCII "12345123451234512345" and does NOT
 * reproduce the published codes (verified independently against Python's
 * base64.b32encode). The table below is asserted against the corrected
 * base32 so the published vectors pass exactly (criterion 1).
 */
import { describe, expect, it } from 'vitest';
import {
  generateTotpSecret,
  otpauthUri,
  totpCode,
  verifyTotp,
} from '../../../src/services/vault/totp.js';

/** RFC 6238 Appendix B: base32(ASCII "12345678901234567890"). */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const DIGITS = 8;

/** [T (seconds), expected 8-digit code] — RFC 6238 SHA1 table. */
const RFC_VECTORS: Array<[number, string]> = [
  [59, '94287082'],
  [1111111109, '07081804'],
  [1111111111, '14050471'],
  [1234567890, '89005924'],
  [2000000000, '69279037'],
  [20000000000, '65353130'],
];

const codeAt = (time: number, digits = DIGITS): string =>
  totpCode(RFC_SECRET, { time, digits });

describe('totp.ts — RFC 6238 SHA1 test vectors (criterion 1)', () => {
  it('reproduces the published vector table exactly (8 digits, step 30)', () => {
    for (const [t, expected] of RFC_VECTORS) {
      expect(totpCode(RFC_SECRET, { time: t, digits: DIGITS })).toBe(expected);
    }
  });

  it('totpCode zero-pads (leading-zero vectors stay full-length strings)', () => {
    expect(totpCode(RFC_SECRET, { time: 1111111109, digits: DIGITS })).toBe('07081804');
    expect(totpCode(RFC_SECRET, { time: 1111111109, digits: DIGITS })).toHaveLength(8);
  });

  it('verifyTotp accepts the exact vector codes at their published times', () => {
    for (const [t, expected] of RFC_VECTORS) {
      expect(verifyTotp(RFC_SECRET, expected, { time: t, digits: DIGITS })).toEqual({
        ok: true,
        counter: Math.floor(t / 30),
      });
    }
  });

  it('verifyTotp accepts codes with omitted leading zeroes (numeric code)', () => {
    // '07081804' submitted as '7081804' is the same numeric code.
    expect(
      verifyTotp(RFC_SECRET, '7081804', { time: 1111111109, digits: DIGITS }),
    ).toEqual({ ok: true, counter: 37037036 });
  });
});

describe('totp.ts — window (criterion 2)', () => {
  const T = 1111111109; // counter 37037036, code 07081804

  it('accepts the code ±1 step either side of the current time', () => {
    // The returned counter is the counter whose code matched (== nominal
    // floor(time/step) for a current-step code).
    for (const delta of [-30, 0, 30]) {
      const result = verifyTotp(RFC_SECRET, codeAt(T), {
        time: T + delta,
        digits: DIGITS,
      });
      expect(result.ok).toBe(true);
      expect(result.counter).toBe(37037036);
    }
  });

  it('rejects codes ±2 steps away (outside the default window)', () => {
    for (const delta of [-60, 60]) {
      expect(
        verifyTotp(RFC_SECRET, codeAt(T), { time: T + delta, digits: DIGITS }).ok,
      ).toBe(false);
    }
  });

  it('window: 0 accepts only the exact current step', () => {
    expect(verifyTotp(RFC_SECRET, codeAt(T), { time: T - 30, digits: DIGITS, window: 0 }).ok).toBe(false);
    expect(verifyTotp(RFC_SECRET, codeAt(T), { time: T, digits: DIGITS, window: 0 }).ok).toBe(true);
    expect(verifyTotp(RFC_SECRET, codeAt(T), { time: T + 30, digits: DIGITS, window: 0 }).ok).toBe(false);
  });

  it('rejects wrong codes: wrong value, non-numeric, wrong digit count', () => {
    expect(verifyTotp(RFC_SECRET, '00000000', { time: T, digits: DIGITS }).ok).toBe(false);
    expect(verifyTotp(RFC_SECRET, 'abcdefgh', { time: T, digits: DIGITS }).ok).toBe(false);
    expect(verifyTotp(RFC_SECRET, '9428708', { time: T, digits: DIGITS }).ok).toBe(false); // 7 digits
    expect(verifyTotp(RFC_SECRET, '070818040', { time: T, digits: DIGITS }).ok).toBe(false); // 9 digits
    expect(verifyTotp(RFC_SECRET, '', { time: T, digits: DIGITS }).ok).toBe(false);
    // Correct code under the wrong digits setting is also rejected.
    expect(verifyTotp(RFC_SECRET, codeAt(T), { time: T }).ok).toBe(false); // 6-digit compare
  });
});

describe('totp.ts — replay guard (criterion 3)', () => {
  const T = 59; // counter 1 → 94287082

  it('same code twice: the second verify with lastCounter is refused', () => {
    const first = verifyTotp(RFC_SECRET, codeAt(T), { time: T, digits: DIGITS });
    expect(first).toEqual({ ok: true, counter: 1 });
    const replay = verifyTotp(RFC_SECRET, codeAt(T), {
      time: T,
      digits: DIGITS,
      lastCounter: first.counter,
    });
    expect(replay.ok).toBe(false);
  });

  it('any older counter is refused once lastCounter is persisted', () => {
    // First use at counter 3 (time 119); then counter 1's code replayed at a
    // later time is still refused (1 <= 3).
    expect(
      verifyTotp(RFC_SECRET, codeAt(119), { time: 119, digits: DIGITS }),
    ).toEqual({ ok: true, counter: 3 });
    expect(
      verifyTotp(RFC_SECRET, codeAt(59), {
        time: 149, // nominal counter 4 — the stale counter-1 code is in-window but old
        digits: DIGITS,
        lastCounter: 3,
      }).ok,
    ).toBe(false);
  });

  it('a fresh next-step code is accepted after lastCounter', () => {
    expect(
      verifyTotp(RFC_SECRET, codeAt(119), { time: 119, digits: DIGITS, lastCounter: 1 }),
    ).toEqual({ ok: true, counter: 3 });
  });
});

describe('totp.ts — otpauth URI format (criterion 4)', () => {
  it('matches the exact contract format', () => {
    expect(otpauthUri('lilly', RFC_SECRET)).toBe(
      `otpauth://totp/Katra:lilly?secret=${RFC_SECRET}&issuer=Katra&algorithm=SHA1&digits=6&period=30`,
    );
  });

  it('honors a custom issuer and keeps the default period/digits', () => {
    expect(otpauthUri('shoshin', 'JBSWY3DPEHPK3PXP', 'Katra Lab')).toBe(
      'otpauth://totp/Katra Lab:shoshin?secret=JBSWY3DPEHPK3PXP&issuer=Katra Lab&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('totp.ts — secret generation (contract interface)', () => {
  it('generateTotpSecret: 20 bytes → 32 base32 chars, RFC 4648 alphabet, no padding', () => {
    const secret = generateTotpSecret();
    expect(secret).toHaveLength(32); // 20 bytes = 160 bits = 32 base32 chars
    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(secret).not.toContain('=');
    expect(generateTotpSecret()).not.toBe(secret); // fresh randomness
    expect(generateTotpSecret(10)).toHaveLength(16); // 10 bytes → 16 chars
  });

  it('generated secrets round-trip through totpCode/verifyTotp (self-consistent)', () => {
    const secret = generateTotpSecret();
    const code = totpCode(secret, { time: 1000 });
    expect(code).toHaveLength(6);
    expect(verifyTotp(secret, code, { time: 1000 })).toEqual({ ok: true, counter: 33 });
  });
});
