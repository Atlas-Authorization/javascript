import { describe, expect, it } from 'vitest';
import Atlas from './index';

describe('Atlas Auth.js provider', () => {
  it('builds an oidc provider with PKCE, state and default scopes', () => {
    const p = Atlas({ issuer: 'https://id.example.com/', clientId: 'c', clientSecret: 's' });
    expect(p).toMatchObject({ id: 'atlas', type: 'oidc', issuer: 'https://id.example.com', checks: ['pkce', 'state'] });
    expect(p.authorization.params.scope).toBe('openid profile email');
  });

  it('appends extra scopes', () => {
    expect(Atlas({ issuer: 'https://x', scope: 'offline_access' }).authorization.params.scope).toBe('openid profile email offline_access');
  });

  it('maps the profile, composing a name when only parts exist', () => {
    const p = Atlas({ issuer: 'https://x' });
    expect(p.profile({ sub: 'u1', given_name: 'Ada', family_name: 'Lovelace', email: 'a@x.io', picture: 'p' })).toEqual({
      id: 'u1',
      name: 'Ada Lovelace',
      email: 'a@x.io',
      image: 'p',
    });
    expect(p.profile({ sub: 'u2' })).toEqual({ id: 'u2', name: null, email: null, image: null });
  });

  it('requires an issuer', () => {
    expect(() => Atlas({} as never)).toThrow(/issuer/);
  });
});
