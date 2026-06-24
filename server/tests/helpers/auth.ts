/**
 * Auth test helpers — verify API key generation, hashing, and validation.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export function generateTestKey(prefix = 'test'): string {
  return `${prefix}-${randomBytes(16).toString('hex')}`;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  try {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * Simulate the validateMcpKey flow:
 * 1. Generate a key → hash it → store hash
 * 2. Present the key → hash the incoming key → compare to stored hash
 */
export class MockKeyStore {
  private hashes: Map<string, string> = new Map();

  registerKey(keyName: string, plaintext: string): void {
    this.hashes.set(keyName, hashApiKey(plaintext));
  }

  validate(keyName: string, token: string): boolean {
    const storedHash = this.hashes.get(keyName);
    if (!storedHash) return false;
    const incomingHash = hashApiKey(token);
    return constantTimeEqual(incomingHash, storedHash);
  }
}
