import { beforeEach, describe, expect, it } from 'vitest';
import { decodeJwt } from 'jose';
import {
  oidcCallback,
  oidcOrganizationOf,
  oidcOrganizationsOf,
  oidcSsoOf,
  oidcStart,
  resetOidcCaches,
} from './oidc';
import { createTestIssuer, testTenantClaims, type TestIssuer } from './testing';

/**
 * The organization / enterprise SSO context on Atlas ID tokens, as the RP sees
 * it through `oidc.callback`, and the test issuer's way of minting it.
 */

const REDIRECT = 'https://app.example.com/auth/callback';
const SECRET = 'a-test-secret-that-is-at-least-32-characters';

beforeEach(() => resetOidcCaches());

async function signIn(
  fx: TestIssuer,
  opts: { organization?: string; scope?: string; authorize?: Parameters<TestIssuer['authorize']>[1] } = {},
) {
  const started = await oidcStart({
    issuer: fx.issuer,
    clientId: fx.clientId,
    redirectUri: REDIRECT,
    scope: opts.scope,
    organization: opts.organization,
    secret: SECRET,
    fetchImpl: fx.fetch,
  });
  const back = await fx.authorize(started.url, opts.authorize);
  const identity = await oidcCallback({
    issuer: fx.issuer,
    clientId: fx.clientId,
    redirectUri: REDIRECT,
    query: back.callbackUrl,
    cookie: started.cookie.split(';')[0],
    secret: SECRET,
    fetchImpl: fx.fetch,
  });
  return { started, identity };
}

describe('oidc.callback organization and SSO context', () => {
  it('is null everywhere when the sign-in involved no organization', async () => {
    const fx = await createTestIssuer();
    const { identity } = await signIn(fx);
    expect(identity.organization).toBeNull();
    expect(identity.organizations).toBeNull();
    expect(identity.sso).toBeNull();
  });

  it('reads org_*, orgs and sso_* from the verified ID token', async () => {
    const fx = await createTestIssuer();
    const { identity } = await signIn(fx, {
      scope: 'openid organizations',
      authorize: {
        organization: { id: 'org_1', slug: 'acme', role: 'org:admin', permissions: ['org:billing:manage'] },
        organizations: [
          { id: 'org_1', slug: 'acme', role: 'org:admin' },
          { id: 'org_2', slug: 'globex', role: 'org:member' },
        ],
        sso: {
          connectionId: 'sso_conn_1',
          organizationId: 'org_3',
          type: 'saml',
          tenantId: '9188040d-6c67-4c5b-b112-36a304b66dad',
          issuer: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0',
          domain: 'acme.com',
        },
      },
    });
    expect(identity.organization).toEqual({
      id: 'org_1',
      slug: 'acme',
      role: 'org:admin',
      permissions: ['org:billing:manage'],
    });
    expect(identity.organizations).toEqual([
      { id: 'org_1', slug: 'acme', role: 'org:admin' },
      { id: 'org_2', slug: 'globex', role: 'org:member' },
    ]);
    expect(identity.sso).toEqual({
      connectionId: 'sso_conn_1',
      // The owning org is independent of the org the sign-in was made in.
      organizationId: 'org_3',
      type: 'saml',
      tenantId: '9188040d-6c67-4c5b-b112-36a304b66dad',
      issuer: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0',
      domain: 'acme.com',
    });
    // The raw claims carry the same names a session token uses.
    expect(identity.claims.org_id).toBe('org_1');
    expect(identity.claims.org_role).toBe('org:admin');
    expect(identity.claims.sso_connection_id).toBe('sso_conn_1');
    expect(identity.claims.sso_organization_id).toBe('org_3');
    expect(identity.claims.sso_connection_type).toBe('saml');
  });

  it('sends `organization` on the authorize URL, and the test issuer issues the token in it', async () => {
    const fx = await createTestIssuer();
    const { started, identity } = await signIn(fx, { organization: 'acme' });
    expect(new URL(started.url).searchParams.get('organization')).toBe('acme');
    expect(identity.organization).toEqual({ id: 'acme', slug: 'acme', role: 'org:member', permissions: [] });
  });

  it('explicit claims still win over the tenant shorthand', async () => {
    const fx = await createTestIssuer();
    const token = await fx.mintIdToken(
      { org_role: 'org:owner' },
      { organization: { id: 'org_9', slug: 'initech' }, sso: { connectionId: 'saml_c' } },
    );
    const claims = decodeJwt(token);
    expect(claims.org_id).toBe('org_9');
    expect(claims.org_slug).toBe('initech');
    expect(claims.org_role).toBe('org:owner');
    expect(claims.org_permissions).toEqual([]);
    expect(claims.sso_connection_id).toBe('saml_c');
    expect(claims.sso_tenant_id).toBeUndefined();
    expect(claims.sso_organization_id).toBeUndefined();
    expect(claims.sso_connection_type).toBe('oidc');
  });
});

describe('claim readers', () => {
  it('ignore malformed values instead of throwing', () => {
    expect(oidcOrganizationOf({ org_id: 5 })).toBeNull();
    expect(oidcOrganizationOf({ org_id: 'org_1', org_permissions: ['a', 3] })).toEqual({
      id: 'org_1',
      slug: '',
      role: '',
      permissions: ['a'],
    });
    expect(oidcOrganizationsOf({ orgs: 'nope' })).toBeNull();
    expect(oidcOrganizationsOf({ orgs: [null, { id: 'org_1', slug: 'a', role: 'r' }, { slug: 'x' }] })).toEqual([
      { id: 'org_1', slug: 'a', role: 'r' },
    ]);
    expect(oidcSsoOf({ sso_connection_id: 'c', sso_domain: 7, sso_connection_type: 'ldap' })).toEqual({
      connectionId: 'c',
      organizationId: null,
      type: null,
      tenantId: null,
      issuer: null,
      domain: null,
    });
  });

  it('testTenantClaims maps the context to Atlas claim names', () => {
    expect(testTenantClaims({})).toEqual({});
    expect(testTenantClaims({ sso: { connectionId: 'c', domain: 'acme.com' } })).toEqual({
      sso_connection_id: 'c',
      sso_connection_type: 'oidc',
      sso_domain: 'acme.com',
    });
    expect(testTenantClaims({ sso: { connectionId: 'c', organizationId: 'org_1', type: 'saml' } })).toEqual({
      sso_connection_id: 'c',
      sso_organization_id: 'org_1',
      sso_connection_type: 'saml',
    });
  });
});
