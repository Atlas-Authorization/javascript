import { describe, expect, it } from 'vitest';
import { connectionSet, discoveryUrl, oidcConnection, parseDiscovery, parseSamlMetadata, samlConnections } from './sso-metadata';

const CERT = 'MIIBszCCAVmgAwIBAgIUQ1Zq';
const PING = `<?xml version="1.0"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="https://auth.pingone.com/3f2b/idp">
  <md:IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>
      ${CERT}
    </ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:KeyDescriptor use="encryption"><ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>ENCRYPTONLY</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>
    <md:NameIDFormat>urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress</md:NameIDFormat>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="https://auth.pingone.com/3f2b/saml20/idp/sso"/>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="https://auth.pingone.com/3f2b/saml20/idp/sso?x=1&amp;y=2"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;

describe('SAML metadata', () => {
  it('reads entity id, preferred binding, signing certificates only', () => {
    expect(parseSamlMetadata(PING)).toEqual([
      {
        entityId: 'https://auth.pingone.com/3f2b/idp',
        ssoUrl: 'https://auth.pingone.com/3f2b/saml20/idp/sso?x=1&y=2',
        ssoBinding: 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect',
        certificates: [CERT],
        nameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      },
    ]);
  });

  it('builds a connection with a PEM certificate, domains and an organization', () => {
    const { connections, warnings } = samlConnections(PING, { domains: ['corp.example'], name: 'Corp' });
    expect(connections[0]).toMatchObject({ protocol: 'saml', name: 'Corp', domains: ['corp.example'], saml: { idp_entity_id: 'https://auth.pingone.com/3f2b/idp' } });
    expect(connections[0]!.saml!.idp_certificate).toMatch(/^-----BEGIN CERTIFICATE-----\n/);
    expect(warnings).toEqual([]);
    const set = connectionSet(connections, 'SAML metadata', { id: 'org1', name: 'Corp Inc' });
    expect(set.list('sso_connection')[0]!.organization_id).toBe('org1');
    expect(set.count('organization')).toBe(1);
  });

  it('handles federations, unprefixed documents and refuses entities and non-IdP documents', () => {
    const fed = `<EntitiesDescriptor><EntityDescriptor entityID="https://a/idp"><IDPSSODescriptor><SingleSignOnService Binding="x:HTTP-POST" Location="https://a/sso"/></IDPSSODescriptor></EntityDescriptor><EntityDescriptor entityID="https://b/sp"><SPSSODescriptor/></EntityDescriptor><EntityDescriptor entityID="https://c/idp"><IDPSSODescriptor/></EntityDescriptor></EntitiesDescriptor>`;
    const r = samlConnections(fed);
    expect(r.connections.map((c) => c.saml!.idp_entity_id)).toEqual(['https://a/idp', 'https://c/idp']);
    expect(r.warnings.join(' ')).toMatch(/no signing certificate/);
    expect(() => parseSamlMetadata('<!DOCTYPE x [<!ENTITY a "b">]><EntityDescriptor entityID="e"/>')).toThrow(/DOCTYPE/);
    expect(() => parseSamlMetadata('<EntityDescriptor entityID="e"><SPSSODescriptor/></EntityDescriptor>')).toThrow(/No identity provider/);
  });
});

describe('OIDC discovery', () => {
  const doc = { issuer: 'https://idp.example.com', token_endpoint: 'https://idp.example.com/t', jwks_uri: 'https://idp.example.com/k', scopes_supported: ['openid', 'email'], grant_types_supported: ['password'] };
  it('builds the discovery URL and a connection', () => {
    expect(discoveryUrl('https://idp.example.com/')).toBe('https://idp.example.com/.well-known/openid-configuration');
    expect(() => discoveryUrl('http://idp.example.com')).toThrow(/https/);
    expect(oidcConnection(parseDiscovery(doc, 'https://idp.example.com'), { clientId: 'c' })).toMatchObject({
      protocol: 'oidc',
      oidc: { issuer: 'https://idp.example.com', client_id: 'c', scopes: ['openid', 'email'] },
    });
  });
  it('refuses a document for another issuer', () => {
    expect(() => parseDiscovery(doc, 'https://evil.example.com')).toThrow(/not https:\/\/evil/);
    expect(() => parseDiscovery({}, 'https://x')).toThrow(/no issuer/);
  });
});
