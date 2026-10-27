import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProposition,
  episodicPropositionKey,
  semanticPropositionKey,
} from './proposition-key.mjs';

test('normalisation preserves negation, numerals and order', () => {
  assert.notEqual(normalizeProposition('did not fail'), normalizeProposition('did fail'));
  assert.notEqual(normalizeProposition('version 1'), normalizeProposition('version 2'));
  assert.notEqual(normalizeProposition('get root cause'), normalizeProposition('get cause root'));
  assert.equal(normalizeProposition('Get from Satori!'), 'get satori');
});

test('semantic key matches the runtime rule', () => {
  assert.equal(
    semanticPropositionKey('fact: The user associated with this session is satori.'),
    'the user associated session satori',
  );
  assert.equal(semanticPropositionKey('done'), null);
  assert.notEqual(
    semanticPropositionKey('Do not upgrade kolega code on thebrick'),
    semanticPropositionKey('Do upgrade kolega code on thebrick'),
  );
});

test('episodic key is sha256(type:normalized).slice(0,32)', () => {
  const key = episodicPropositionKey('goal', 'Get the reflection root cause from Satori');
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(key, episodicPropositionKey('goal', 'get the reflection root cause from satori'));
  assert.notEqual(key, episodicPropositionKey('goal', 'Get the root cause from Satori'));
});
