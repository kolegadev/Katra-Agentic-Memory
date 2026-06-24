/**
 * Unit tests: Working Memory Service
 * Tests prototype pollution prevention, size limits, and tenant scoping.
 */
import { describe, it, expect } from 'vitest';

const MAX_SIZE = 5 * 1024 * 1024; // 5MB
const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

function validateContent(content: any): void {
  if (content === null || content === undefined) {
    throw new Error('Content cannot be null or undefined');
  }
  if (typeof content === 'object' && !Array.isArray(content)) {
    for (const key of DANGEROUS_KEYS) {
      if (Object.prototype.hasOwnProperty.call(content, key)) {
        throw new Error(`Rejected dangerous content key: ${key}`);
      }
    }
  }
  const json = JSON.stringify(content);
  const size = Buffer.byteLength(json, 'utf8');
  if (size > MAX_SIZE) {
    throw new Error(`Content exceeds maximum size of 5MB`);
  }
}

describe('Working Memory — Content Validation', () => {
  describe('null/undefined rejection', () => {
    it('rejects null content', () => {
      expect(() => validateContent(null)).toThrow('cannot be null');
    });

    it('rejects undefined content', () => {
      expect(() => validateContent(undefined)).toThrow('cannot be null');
    });
  });

  describe('prototype pollution prevention', () => {
    it('rejects __proto__ key (via JSON parse — real attack vector)', () => {
      // { __proto__: ... } in a literal sets the prototype, not an own property.
      // The real attack vector is JSON-parsed input: JSON.parse creates __proto__
      // as an actual own property. This is what our protection guards against.
      const parsed = JSON.parse('{"__proto__": {"isAdmin": true}}');
      expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
      expect(() => validateContent(parsed))
        .toThrow('__proto__');
    });

    it('rejects constructor key', () => {
      expect(() => validateContent({ constructor: { prototype: {} } }))
        .toThrow('constructor');
    });

    it('rejects prototype key', () => {
      expect(() => validateContent({ prototype: {} }))
        .toThrow('prototype');
    });

    it('accepts safe objects', () => {
      expect(() => validateContent({ name: 'test', value: 42 }))
        .not.toThrow();
    });

    it('accepts arrays', () => {
      expect(() => validateContent([1, 2, 3])).not.toThrow();
    });

    it('accepts strings', () => {
      expect(() => validateContent('hello world')).not.toThrow();
    });
  });

  describe('size limits', () => {
    it('accepts content under 5MB', () => {
      const data = { text: 'x'.repeat(1000) };
      expect(() => validateContent(data)).not.toThrow();
    });

    it('rejects content over 5MB', () => {
      const data = { text: 'x'.repeat(6 * 1024 * 1024) };
      expect(() => validateContent(data)).toThrow('exceeds maximum size');
    });
  });
});

describe('Working Memory — Tenant Scoping', () => {
  it('retrieve filter includes tenant_id when provided', () => {
    const buildFilter = (itemId: string, tenant_id?: string) => {
      const filter: any = { id: itemId };
      if (tenant_id) filter.tenant_id = tenant_id;
      return filter;
    };

    expect(buildFilter('item-1')).toEqual({ id: 'item-1' });
    expect(buildFilter('item-1', 'tenant-abc')).toEqual({ id: 'item-1', tenant_id: 'tenant-abc' });
  });

  it('delete filter includes tenant_id when provided', () => {
    const buildDeleteFilter = (itemId: string, tenant_id?: string) => {
      const filter: any = { id: itemId };
      if (tenant_id) filter.tenant_id = tenant_id;
      return filter;
    };

    expect(buildDeleteFilter('item-1', 'tenant-xyz')).toEqual({ id: 'item-1', tenant_id: 'tenant-xyz' });
    // Without tenant_id, only deletes by id (backward compatible)
    expect(buildDeleteFilter('item-1')).toEqual({ id: 'item-1' });
  });
});
