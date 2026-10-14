import { describe, expect, it } from 'vitest';
import {
  canonicalString,
  deepEqual,
  deserialize,
  serialize,
  type Format,
  type Json,
} from './serialize';

const SAMPLES: Json[] = [
  { b: 1, a: 'two', c: [3, 2, 1], d: { z: true, y: null } },
  [],
  {},
  { list: [{ name: 'x' }, { name: 'y' }], empty_arr: [], empty_obj: {} },
  // Newlines and quotes in a value (an email/notification body).
  { subject: 'Welcome!', text: 'Line one\nLine two\t"quoted"\\back' },
  // URL-shaped MAP KEYS (a JWT claims map).
  { claims: { 'https://example.com/role': '{{user.role}}', sub: '{{user.id}}' } },
  // Nested arrays of objects.
  { scopes: [{ value: 'read', description: 'Read' }, { value: 'write' }] },
  'a bare scalar',
  42,
  true,
  null,
];

describe('canonicalization', () => {
  it('sorts object keys recursively but preserves array order', () => {
    const s = canonicalString({ b: 1, a: { d: 4, c: 3 }, arr: [3, 1, 2] });
    expect(s).toBe('{"a":{"c":3,"d":4},"arr":[3,1,2],"b":1}');
  });

  it('treats key order as insignificant for equality', () => {
    expect(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(deepEqual({ a: [1, 2] }, { a: [2, 1] })).toBe(false); // array order matters
  });

  it('drops undefined so it never reaches disk', () => {
    expect(canonicalString({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});

describe.each<Format>(['json', 'yaml'])('%s codec', (format) => {
  it('round-trips every sample exactly', () => {
    for (const sample of SAMPLES) {
      const text = serialize(sample, format);
      const back = deserialize(text, format);
      expect(canonicalString(back)).toBe(canonicalString(sample));
    }
  });

  it('is deterministic — the same value serializes identically every time', () => {
    const a = serialize({ b: 1, a: 2, nested: { y: 1, x: 2 } }, format);
    const b = serialize({ a: 2, nested: { x: 2, y: 1 }, b: 1 }, format);
    expect(a).toBe(b);
    expect(a.endsWith('\n')).toBe(true);
  });
});

describe('yaml specifics', () => {
  it('encodes keys and scalars as JSON so a URL key is unambiguous', () => {
    const text = serialize({ claims: { 'https://x/y': 'v' } }, 'yaml');
    expect(text).toContain('"https://x/y": "v"');
  });

  it('keeps newlines inside a value as an escaped JSON scalar (one physical line)', () => {
    const text = serialize({ body: 'a\nb' }, 'yaml');
    expect(text).toContain('"body": "a\\nb"');
    expect(deserialize(text, 'yaml')).toEqual({ body: 'a\nb' });
  });
});
