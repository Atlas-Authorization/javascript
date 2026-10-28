import { describe, expect, it } from 'vitest';
import { PresetVariableError, getMigrationBridgePreset, resolveMigrationBridgePreset } from './migration-presets';

/**
 * The Stytch bridge preset against what Stytch documents: session JWTs are
 * RS256, issuer `stytch.com/<project id>`, audience the project id, the
 * `https://stytch.com/session` object claim holds the session id, keys at
 * `/v1/sessions/jwks/<project id>` (consumer) or `/v1/b2b/sessions/jwks/<project id>`
 * (B2B) on api.stytch.com (live) or test.stytch.com (test); the browser holds
 * the JWT in the `stytch_session_jwt` cookie.
 */
const PROJECT = 'project-live-11111111-2222-3333-4444-555555555555';

describe('stytch bridge preset', () => {
  it('resolves the consumer defaults', () => {
    const r = resolveMigrationBridgePreset('stytch', { project_id: PROJECT });
    expect(r.issuer).toBe(`stytch.com/${PROJECT}`);
    expect(r.keysUrl).toBe(`https://api.stytch.com/v1/sessions/jwks/${PROJECT}`);
    expect(r.audience).toEqual([PROJECT]);
    expect(r.algorithms).toEqual(['RS256']);
    expect(r.claims.subject).toBe('sub');
    expect(r.claims.sessionKey).toBe('https://stytch.com/session.id');
    expect(r.cookies).toEqual(['stytch_session_jwt']);
    expect(r.clearCookies).toEqual(['stytch_session_jwt', 'stytch_session']);
    expect(r.mode).toBe('jwt');
  });

  it('points B2B at the b2b keys and a test project at test.stytch.com', () => {
    const b2b = resolveMigrationBridgePreset('stytch', { project_id: PROJECT, jwks_path: 'b2b/sessions' });
    expect(b2b.keysUrl).toBe(`https://api.stytch.com/v1/b2b/sessions/jwks/${PROJECT}`);
    const test = resolveMigrationBridgePreset('stytch', { project_id: 'project-test-aaaa', api_host: 'test.stytch.com' });
    expect(test.keysUrl).toBe('https://test.stytch.com/v1/sessions/jwks/project-test-aaaa');
    expect(test.issuer).toBe('stytch.com/project-test-aaaa');
  });

  it('needs the project id and refuses a path trick in the keys path', () => {
    expect(() => resolveMigrationBridgePreset('stytch', {})).toThrow(PresetVariableError);
    expect(() => resolveMigrationBridgePreset('stytch', { project_id: PROJECT, jwks_path: '../x' })).toThrow(PresetVariableError);
  });

  it('keeps the grace window for the short-lived session JWT', () => {
    expect(getMigrationBridgePreset('stytch')?.jwt?.expiredGraceSeconds).toBeGreaterThan(0);
  });
});
