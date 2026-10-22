import { describe, it, expect } from 'vitest';
import { propositionKeyOf } from '../../src/services/memory/proposition-key.js';

describe('propositionKeyOf — semantic-fact re-wording is an occurrence', () => {
  it('keys the same proposition identically across case, punctuation and word order', () => {
    const a = propositionKeyOf('Upgrade kolega-code from 0.42.0 to 0.45.0 on thebrick.');
    const b = propositionKeyOf('on thebrick upgrade KOLEGA code to 0.45.0 from 0.42.0');
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  it('keys the filler sentence that dominated the store', () => {
    const a = propositionKeyOf('fact: The user associated with this session is satori.');
    const b = propositionKeyOf('The user associated with this session, is Satori');
    expect(a).toBe(b);
  });

  it('keeps different propositions apart', () => {
    const upgrade = propositionKeyOf('Upgrade kolega-code to 0.45.0 from 0.42.0 on thebrick');
    const uninstall = propositionKeyOf('Uninstall kolega-code to 0.45.0 from 0.42.0 on thebrick');
    expect(upgrade).not.toBe(uninstall);
  });

  it('refuses short text, where two different facts look the same', () => {
    expect(propositionKeyOf('done')).toBeNull();
    expect(propositionKeyOf('retry later')).toBeNull();
    expect(propositionKeyOf('katra server restarted')).toBeNull();
  });

  it('refuses empty and missing content', () => {
    expect(propositionKeyOf('')).toBeNull();
    expect(propositionKeyOf(undefined)).toBeNull();
    expect(propositionKeyOf(null)).toBeNull();
    expect(propositionKeyOf('   ...   ')).toBeNull();
  });
});
