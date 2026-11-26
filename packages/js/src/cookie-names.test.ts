import { describe, expect, it } from 'vitest';
import { cookieSuffixForKey, readAtlasCookie } from './cookie-names';
import { getCsrfToken, csrfHeadersFor } from './csrf';
import { mayHaveSession } from './session-continuity';

const PK = 'pk_live_ins_01M2TNDMWWABCDEFGH12';
const SFX = 'cdefgh12';

describe('cookie isolation in the browser SDK', () => {
  it('derives the same suffix as the server', () => {
    expect(cookieSuffixForKey(PK)).toBe(SFX);
  });

  it('reads the suffixed cookie of its own key, then the plain one, never another instance\'s', () => {
    expect(readAtlasCookie(`__atlas_csrf_${SFX}=a; __atlas_csrf=b`, '__atlas_csrf', PK)).toBe('a');
    expect(readAtlasCookie('__atlas_csrf=b', '__atlas_csrf', PK)).toBe('b');
    expect(readAtlasCookie('__atlas_csrf_zzzzzzzz=c', '__atlas_csrf', PK)).toBeNull();
  });

  it('without a key, reads the one suffixed cookie on the page', () => {
    expect(readAtlasCookie(`__atlas_csrf_${SFX}=a`, '__atlas_csrf')).toBe('a');
    expect(readAtlasCookie(`__atlas_csrf_${SFX}=a; __atlas_csrf_zzzzzzzz=c`, '__atlas_csrf')).toBeNull();
  });

  it('getCsrfToken, csrfHeadersFor and mayHaveSession follow the key', () => {
    expect(getCsrfToken(`__atlas_csrf_${SFX}=tok; __atlas_csrf_zzzzzzzz=other`, PK)).toBe('tok');
    expect(getCsrfToken(`__atlas_csrf_zzzzzzzz=other`, PK)).toBeNull();
    expect(csrfHeadersFor('GET', PK)).toEqual({});
    expect(mayHaveSession(`__atlas_uat_${SFX}=1700000000`, PK)).toBe(true);
    expect(mayHaveSession(`__atlas_uat_zzzzzzzz=1700000000`, PK)).toBe(false);
    expect(mayHaveSession('__atlas_uat=1700000000', PK)).toBe(true);
    expect(mayHaveSession('__atlas_uat=x')).toBe(false);
  });
});
