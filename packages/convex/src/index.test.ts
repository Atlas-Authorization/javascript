import { describe, expect, it } from 'vitest';
import { atlasAuthConfig, atlasAuthProvider, isSharedAtlasIssuer, sharedInstanceJwksUrl } from './index';

describe('atlasAuthConfig', () => {
  it('a custom frontend domain is an OIDC provider with the template audience', () => {
    expect(atlasAuthConfig({ issuer: 'https://auth.example.com/' })).toEqual({
      providers: [{ domain: 'https://auth.example.com', applicationID: 'convex' }],
    });
    expect(atlasAuthProvider({ issuer: 'https://auth.example.com', applicationID: 'my-app' })).toEqual({
      domain: 'https://auth.example.com',
      applicationID: 'my-app',
    });
  });

  it('the shared host is a custom-JWT provider on the per-instance key set', () => {
    expect(atlasAuthProvider({ issuer: 'https://atlasauth.net', instanceId: 'ins_01ABC' })).toEqual({
      type: 'customJwt',
      issuer: 'https://atlasauth.net',
      jwks: 'https://api.atlasauth.net/instances/ins_01ABC/.well-known/jwks.json',
      algorithm: 'RS256',
      applicationID: 'convex',
    });
    // No audience pinned: the provider omits applicationID.
    expect(atlasAuthProvider({ issuer: 'https://atlasauth.net', instanceId: 'ins_01ABC', applicationID: null })).not.toHaveProperty(
      'applicationID',
    );
  });

  it('an explicit jwks URL wins on any host', () => {
    expect(atlasAuthProvider({ issuer: 'https://auth.example.com', jwks: 'https://keys.example.com/jwks.json' })).toMatchObject({
      type: 'customJwt',
      jwks: 'https://keys.example.com/jwks.json',
    });
  });

  it('refuses what Convex could never verify', () => {
    expect(() => atlasAuthProvider({ issuer: 'https://atlasauth.net' })).toThrow(/instanceId/);
    expect(() => atlasAuthProvider({ issuer: 'not a url' })).toThrow(/absolute URL/);
    expect(() => atlasAuthProvider({ issuer: 'http://auth.example.com' })).toThrow(/https/);
    expect(() => atlasAuthProvider({ issuer: 'https://auth.example.com', applicationID: null })).toThrow(/applicationID/);
    expect(() => sharedInstanceJwksUrl('../../evil')).toThrow(/ins_/);
  });

  it('recognises the shared host however it is written', () => {
    expect(isSharedAtlasIssuer('https://atlasauth.net/')).toBe(true);
    expect(isSharedAtlasIssuer('https://auth.example.com')).toBe(false);
  });
});
