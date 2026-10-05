import { describe, it, expect } from 'vitest';
import { AtlasBackend } from './verify';

/**
 * §migration redirect forwarding — the SDK helper that turns a kept-your-own
 * provider callback into a one-line 302 to Atlas. Pure URL construction; no
 * network.
 */
const atlas = new AtlasBackend({
  issuer: 'https://auth.restorehub.net',
  jwksUrl: 'https://auth.restorehub.net/.well-known/jwks.json',
});

describe('oauthCallbackForwardUrl', () => {
  it('builds the Atlas callback on the issuer host, preserving code + state', () => {
    const url = atlas.oauthCallbackForwardUrl('github', 'code=abc&state=xyz');
    expect(url).toBe(
      'https://auth.restorehub.net/v1/oauth/callback/github?code=abc&state=xyz',
    );
  });

  it("accepts Node's req.url (path + query)", () => {
    const url = atlas.oauthCallbackForwardUrl('github', '/auth/github/callback?code=a&state=b');
    expect(url).toBe('https://auth.restorehub.net/v1/oauth/callback/github?code=a&state=b');
  });

  it("accepts a full URL and Express's req.query object", () => {
    expect(atlas.oauthCallbackForwardUrl('discord', 'https://api.x.com/cb?code=1&state=2')).toBe(
      'https://auth.restorehub.net/v1/oauth/callback/discord?code=1&state=2',
    );
    expect(atlas.oauthCallbackForwardUrl('discord', { code: '1', state: '2' })).toBe(
      'https://auth.restorehub.net/v1/oauth/callback/discord?code=1&state=2',
    );
  });

  it('preserves provider error params (denied consent, etc.)', () => {
    const url = atlas.oauthCallbackForwardUrl('github', {
      error: 'access_denied',
      error_description: 'user cancelled',
      state: 's',
    });
    expect(url).toContain('error=access_denied');
    expect(url).toContain('error_description=user+cancelled');
    expect(url).toContain('state=s');
  });

  it('drops params it does not recognise (no open passthrough)', () => {
    const url = atlas.oauthCallbackForwardUrl('github', 'code=a&state=b&evil=1&redirect=http://x');
    expect(url).not.toContain('evil');
    expect(url).not.toContain('redirect=');
  });

  it('rejects a provider key with path-injection characters', () => {
    expect(() => atlas.oauthCallbackForwardUrl('../../evil', 'code=a')).toThrow();
    expect(() => atlas.oauthCallbackForwardUrl('git hub', 'code=a')).toThrow();
  });

  it('handles no usable params (bare path) without a trailing ?', () => {
    expect(atlas.oauthCallbackForwardUrl('github', '/cb')).toBe(
      'https://auth.restorehub.net/v1/oauth/callback/github',
    );
  });
});
