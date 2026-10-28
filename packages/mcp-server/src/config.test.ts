import { describe, expect, it } from 'vitest';
import { resolveOptions } from './config';

describe('resolveOptions API base', () => {
  const base = { ATLAS_SECRET_KEY: 'sk_test_x' };
  it('reads ATLAS_API_BASE and ATLAS_API_URL, BASE winning when both are set', () => {
    expect(resolveOptions({ ...base, ATLAS_API_BASE: 'https://base.test' }, []).apiUrl).toBe('https://base.test');
    expect(resolveOptions({ ...base, ATLAS_API_URL: 'https://url.test' }, []).apiUrl).toBe('https://url.test');
    expect(resolveOptions({ ...base, ATLAS_API_BASE: 'https://base.test', ATLAS_API_URL: 'https://url.test' }, []).apiUrl).toBe('https://base.test');
  });
  it('an explicit --api-url flag beats both', () => {
    expect(
      resolveOptions({ ...base, ATLAS_API_BASE: 'https://base.test' }, ['--api-url', 'https://flag.test']).apiUrl,
    ).toBe('https://flag.test');
  });
});
