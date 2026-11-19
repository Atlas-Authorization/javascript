import { beforeEach, describe, expect, it } from 'vitest';
import { pageVisitToken, parseVisitToken, resetPageVisitToken } from './visit';

describe('atlas_visit on the page', () => {
  beforeEach(resetPageVisitToken);
  it('validates the format', () => {
    expect(parseVisitToken('v1.abc_DEF-1.2~3')).toBe('v1.abc_DEF-1.2~3');
    expect(parseVisitToken('x1.abc')).toBeNull();
    expect(parseVisitToken(`v1.${'a'.repeat(126)}`)).toBeNull();
    expect(parseVisitToken('v1.a b')).toBeNull();
  });
  it('is read from the query and remembered after navigation drops it', () => {
    expect(pageVisitToken('?atlas_visit=nope')).toBeNull();
    expect(pageVisitToken('?x=1&atlas_visit=v1.abc')).toBe('v1.abc');
    expect(pageVisitToken('')).toBe('v1.abc');
  });
});
