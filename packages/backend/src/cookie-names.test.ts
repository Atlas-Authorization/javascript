import { describe, expect, it } from 'vitest';
import { cookieNameFor, cookieSuffixForKey, readAtlasCookie, readSessionCookie, resolveCookieSuffix } from './cookie-names';
import { deriveAuthStatus } from './auth-status';
import { submittedMatchingCookie } from './csrf';

const PK = 'pk_live_ins_01M2TNDMWWABCDEFGH12';
const SFX = 'cdefgh12';

describe('cookie names', () => {
  it('derives the suffix from a publishable key or an instance id, and an explicit one wins', () => {
    expect(cookieSuffixForKey(PK)).toBe(SFX);
    expect(resolveCookieSuffix({ publishableKey: PK })).toBe(SFX);
    expect(resolveCookieSuffix({ publishableKey: 'ins_01M2TNDMWWABCDEFGH12' })).toBe(SFX);
    expect(resolveCookieSuffix({ publishableKey: PK, cookieSuffix: 'abc12345' })).toBe('abc12345');
    expect(resolveCookieSuffix({ publishableKey: PK, cookieSuffix: '' })).toBe('');
    expect(resolveCookieSuffix({})).toBe('');
  });

  it('builds the cookie name', () => {
    expect(cookieNameFor('__session', SFX)).toBe(`__session_${SFX}`);
    expect(cookieNameFor('__session', '')).toBe('__session');
    expect(cookieNameFor('__atlas_csrf', { publishableKey: PK })).toBe(`__atlas_csrf_${SFX}`);
  });

  it('reads the suffixed cookie first, then the plain one', () => {
    const jar = `__session=plain; __session_${SFX}=mine; __session_zzzzzzzz=theirs`;
    expect(readSessionCookie(jar, SFX)).toBe('mine');
    expect(readSessionCookie('__session=plain', SFX)).toBe('plain');
    expect(readAtlasCookie(`__atlas_rt_${SFX}=rt`, '__atlas_rt', SFX)).toBe('rt');
    expect(readSessionCookie(`__session_zzzzzzzz=theirs`, SFX)).toBeUndefined();
  });

  it('with no suffix known, reads a single suffixed session cookie and nothing ambiguous', () => {
    expect(readSessionCookie(`__session_${SFX}=mine`)).toBe('mine');
    expect(readSessionCookie(`__session_${SFX}=a; __session_zzzzzzzz=b`)).toBeUndefined();
    expect(readSessionCookie(`__session=plain; __session_${SFX}=mine`)).toBe('plain');
  });
});

describe('with cookie isolation', () => {
  it('a suffixed refresh cookie or hint makes an expired session renewable', () => {
    expect(deriveAuthStatus(null, `__atlas_rt_${SFX}=rt`, SFX).status).toBe('session_expired');
    expect(deriveAuthStatus(null, `__atlas_uat_${SFX}=1700000000`, SFX).status).toBe('session_expired');
    expect(deriveAuthStatus(null, `__atlas_rt_zzzzzzzz=rt`, SFX).status).toBe('signed_out');
  });

  it('the CSRF echo is compared with the suffixed cookie', async () => {
    const request = (cookie: string) => ({ headers: { get: (n: string) => ({ cookie, 'x-atlas-csrf': 'tok' } as Record<string, string>)[n] ?? null } });
    expect(await submittedMatchingCookie(request(`__atlas_csrf_${SFX}=tok`), SFX)).toBe('tok');
    expect(await submittedMatchingCookie(request(`__atlas_csrf=tok`), SFX)).toBe('tok');
    expect(await submittedMatchingCookie(request(`__atlas_csrf_zzzzzzzz=tok`), SFX)).toBeNull();
  });
});
