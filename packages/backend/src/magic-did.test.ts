import { describe, expect, it } from 'vitest';
import { looksLikeMagicDidToken, magicDidTokenExtractor } from './magic-did';
import { resolveMigrationBridgePreset } from './migration-presets';

// Magic's own Admin SDK test vector (magic-admin-js test/lib/constants.ts, VALID_DIDT).
const DIDT =
  'WyIweGUwMjQzNTVlNDI5ZGNhZDM1MTdhZDk5ZWEzNDEwYWJmZDQ1YjBiNjM5OGIwNjY1NGRiYTQxNzljODdlMTYyNzgxNTc1YjA5ODFjNjU4ZjcwMjYwZTQ5MjMwZGE5NDg4YTA0ZDk5NzBlYjM4ZTZmZGRlY2Q2NTA5YTAyN2IwOGI5MWIiLCJ7XCJpYXRcIjoxNTg1MDExMjA0LFwiZXh0XCI6MTkwMDQxMTIwNCxcImlzc1wiOlwiZGlkOmV0aHI6MHhCMmVjOWI2MTY5OTc2MjQ5MWI2NTQyMjc4RTlkRkVDOTA1MGY4MDg5XCIsXCJzdWJcIjpcIjZ0RlhUZlJ4eWt3TUtPT2pTTWJkUHJFTXJwVWwzbTNqOERReWNGcU8ydHc9XCIsXCJhdWRcIjpcImRpZDptYWdpYzpmNTQxNjhlOS05Y2U5LTQ3ZjItODFjOC03Y2IyYTk2YjI2YmFcIixcIm5iZlwiOjE1ODUwMTEyMDQsXCJ0aWRcIjpcIjJkZGY1OTgzLTk4M2ItNDg3ZC1iNDY0LWJjNWUyODNhMDNjNVwiLFwiYWRkXCI6XCIweDkxZmJlNzRiZTZjNmJmZDhkZGRkZDkzMDExYjA1OWI5MjUzZjEwNzg1NjQ5NzM4YmEyMTdlNTFlMGUzZGYxMzgxZDIwZjUyMWEzNjQxZjIzZWI5OWNjYjM0ZTNiYzVkOTYzMzJmZGViYzhlZmE1MGNkYjQxNWU0NTUwMDk1MmNkMWNcIn0iXQ==';

describe('magicDidTokenExtractor', () => {
  it('picks a DID token out of the Authorization header (plain object and Headers)', async () => {
    const extract = magicDidTokenExtractor();
    expect(await extract({ cookies: {}, headers: { authorization: `Bearer ${DIDT}` } })).toBe(DIDT);
    expect(await extract({ cookies: {}, headers: new Headers({ Authorization: `Bearer ${DIDT}` }) })).toBe(DIDT);
  });

  it('ignores JWTs, other schemes and junk', async () => {
    const extract = magicDidTokenExtractor();
    expect(await extract({ cookies: {}, headers: { authorization: 'Bearer eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJ4In0.c2ln' } })).toBeUndefined();
    expect(await extract({ cookies: {}, headers: { authorization: `Basic ${DIDT}` } })).toBeUndefined();
    expect(await extract({ cookies: {}, headers: {} })).toBeUndefined();
    expect(looksLikeMagicDidToken(btoa('["0x12","{}"]'))).toBe(false);
  });

  it('the magic preset checks the client id as audience and spends tid', () => {
    const r = resolveMigrationBridgePreset('magic', { client_id: 'did:magic:f54168e9-9ce9-47f2-81c8-7cb2a96b26ba' });
    expect(r.mode).toBe('jwt');
    expect(r.audience).toEqual(['did:magic:f54168e9-9ce9-47f2-81c8-7cb2a96b26ba']);
    expect(r.claims).toMatchObject({ subject: 'iss', sessionKey: 'tid' });
    expect(r.bearer).toBe(true);
    expect(r.cookies).toEqual([]);
  });
});
