import type { SsoConnectionRecord } from '@atlasauth/migrate';
import { RecordSet, compact, isObj, str, strs, type Obj } from './record-set';

/**
 * The SSO connections any identity provider hands over as standard documents:
 * SAML 2.0 IdP metadata (an EntityDescriptor, or an EntitiesDescriptor
 * federation) and an OpenID Connect discovery document. Used by the `saml` and
 * `oidc` routes, and by every vendor whose enterprise connections are
 * described by one of the two.
 */

// ── SAML metadata ───────────────────────────────────────────────────────────

const attr = (tag: string, name: string): string | undefined => {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  const v = m ? (m[2] ?? m[3]) : undefined;
  return v === undefined ? undefined : decodeXml(v);
};

function decodeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-f]+|#\d+);/gi, (_, e: string) => {
    const l = e.toLowerCase();
    if (l === 'lt') return '<';
    if (l === 'gt') return '>';
    if (l === 'amp') return '&';
    if (l === 'quot') return '"';
    if (l === 'apos') return "'";
    return String.fromCodePoint(l.startsWith('#x') ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10));
  });
}

/** Elements by local name, ignoring any namespace prefix (`md:`, `ds:`, none). */
function elements(xml: string, local: string): Array<{ tag: string; body: string }> {
  const out: Array<{ tag: string; body: string }> = [];
  const re = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${local}\\b([^>]*?)(/>|>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${local}\\s*>)`, 'g');
  for (let m = re.exec(xml); m; m = re.exec(xml)) out.push({ tag: m[1]!, body: m[3] ?? '' });
  return out;
}

export interface SamlIdp {
  entityId: string;
  ssoUrl?: string;
  ssoBinding?: string;
  certificates: string[];
  nameIdFormat?: string;
  wantAuthnRequestsSigned?: boolean;
}

/** Every identity provider in a metadata document. Throws on a document with none. */
export function parseSamlMetadata(xml: string): SamlIdp[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('The metadata contains a DOCTYPE / ENTITY declaration, which is refused.');
  const idps: SamlIdp[] = [];
  const scoped = elements(xml, 'EntityDescriptor');
  // An EntityDescriptor nested in an EntitiesDescriptor is matched by the regex too; a lone one matches once.
  for (const ed of scoped) {
    const idp = elements(ed.body, 'IDPSSODescriptor')[0];
    const entityId = attr(`${ed.tag}`, 'entityID');
    if (!idp || !entityId) continue;
    const services = elements(idp.body, 'SingleSignOnService').map((s) => ({ binding: attr(s.tag, 'Binding') ?? '', location: attr(s.tag, 'Location') }));
    const pick = services.find((s) => s.binding.endsWith('HTTP-Redirect') && s.location) ?? services.find((s) => s.binding.endsWith('HTTP-POST') && s.location) ?? services.find((s) => s.location);
    const certs: string[] = [];
    for (const k of elements(idp.body, 'KeyDescriptor')) {
      if (attr(k.tag, 'use') === 'encryption') continue;
      for (const c of elements(k.body, 'X509Certificate')) {
        const b64 = c.body.replace(/\s+/g, '');
        if (/^[A-Za-z0-9+/=]+$/.test(b64) && !certs.includes(b64)) certs.push(b64);
      }
    }
    idps.push(compact({
      entityId,
      ssoUrl: pick?.location,
      ssoBinding: pick?.binding,
      certificates: certs,
      nameIdFormat: elements(idp.body, 'NameIDFormat')[0]?.body.trim() || undefined,
      wantAuthnRequestsSigned: attr(idp.tag, 'WantAuthnRequestsSigned') === 'true' ? true : undefined,
    } as SamlIdp));
  }
  if (!idps.length) throw new Error('No identity provider (IDPSSODescriptor) found in the SAML metadata.');
  return idps;
}

const pem = (b64: string) => `-----BEGIN CERTIFICATE-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;

export interface SsoConnectionOptions {
  name?: string;
  domains?: string[];
  organizationId?: string;
  metadataUrl?: string;
  id?: string;
}

export function samlConnections(xml: string, o: SsoConnectionOptions = {}): { connections: SsoConnectionRecord[]; warnings: string[] } {
  const idps = parseSamlMetadata(xml);
  const warnings: string[] = [];
  const connections = idps.map((idp, i): SsoConnectionRecord => {
    // compact() drops an empty certificate list.
    const certificates = idp.certificates ?? [];
    if (!idp.ssoUrl) warnings.push(`${idp.entityId}: no SingleSignOnService in the metadata.`);
    if (!certificates.length) warnings.push(`${idp.entityId}: no signing certificate in the metadata; Atlas cannot verify its assertions.`);
    if (certificates.length > 1) warnings.push(`${idp.entityId}: ${certificates.length} signing certificates; the first is imported, add the others in the dashboard when the IdP rolls its key.`);
    return compact({
      id: o.id ?? (idps.length > 1 ? `${slug(idp.entityId)}-${i + 1}` : slug(idp.entityId)),
      name: o.name ?? hostName(idp.entityId),
      organization_id: o.organizationId,
      protocol: 'saml' as const,
      domains: o.domains,
      enabled: true,
      saml: compact({
        idp_entity_id: idp.entityId,
        idp_sso_url: idp.ssoUrl,
        idp_certificate: certificates[0] ? pem(certificates[0]) : undefined,
        idp_metadata_url: o.metadataUrl,
        idp_metadata_xml: idps.length === 1 ? xml : undefined,
      }),
    } as SsoConnectionRecord);
  });
  return { connections, warnings };
}

const slug = (s: string) => s.replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase().slice(0, 64) || 'saml';
const hostName = (entityId: string) => {
  try {
    return new URL(entityId).host;
  } catch {
    return entityId.slice(0, 64);
  }
};

// ── OIDC discovery ──────────────────────────────────────────────────────────

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
  scopes_supported: string[];
  grant_types_supported: string[];
  id_token_signing_alg_values_supported: string[];
}

/** The discovery URL for an issuer or a discovery URL. */
export function discoveryUrl(input: string): string {
  const u = input.trim().replace(/\/+$/, '');
  if (!/^https:\/\//i.test(u)) throw new Error('The OpenID Connect issuer must be an https:// URL.');
  return u.endsWith('/.well-known/openid-configuration') ? u : `${u}/.well-known/openid-configuration`;
}

export function parseDiscovery(doc: unknown, requested: string): OidcDiscovery {
  if (!isObj(doc) || !str(doc.issuer)) throw new Error('The discovery document has no issuer.');
  const issuer = str(doc.issuer)!;
  const want = requested.replace(/\/\.well-known\/openid-configuration$/, '').replace(/\/+$/, '');
  // RFC 8414 §3.3: the issuer in the document must equal the one it was fetched for.
  if (issuer.replace(/\/+$/, '') !== want) throw new Error(`The discovery document names issuer ${issuer}, not ${want}.`);
  return {
    issuer,
    authorization_endpoint: str(doc.authorization_endpoint),
    token_endpoint: str(doc.token_endpoint),
    userinfo_endpoint: str(doc.userinfo_endpoint),
    jwks_uri: str(doc.jwks_uri),
    scopes_supported: strs(doc.scopes_supported),
    grant_types_supported: strs(doc.grant_types_supported),
    id_token_signing_alg_values_supported: strs(doc.id_token_signing_alg_values_supported),
  };
}

export async function fetchDiscovery(fetchImpl: typeof fetch, input: string): Promise<OidcDiscovery> {
  const url = discoveryUrl(input);
  const res = await fetchImpl(url, { headers: { accept: 'application/json' }, redirect: 'error' });
  if (res.status !== 200) throw new Error(`${url} answered ${res.status}.`);
  return parseDiscovery(await res.json().catch(() => null), input.trim().replace(/\/\.well-known\/openid-configuration$/, ''));
}

export function oidcConnection(d: OidcDiscovery, o: SsoConnectionOptions & { clientId?: string; clientSecret?: string } = {}): SsoConnectionRecord {
  const scopes = ['openid', 'email', 'profile'].filter((s) => d.scopes_supported.length === 0 || d.scopes_supported.includes(s));
  return compact({
    id: o.id ?? slug(d.issuer),
    name: o.name ?? hostName(d.issuer),
    organization_id: o.organizationId,
    protocol: 'oidc' as const,
    domains: o.domains,
    enabled: true,
    oidc: compact({ issuer: d.issuer, discovery_url: discoveryUrl(d.issuer), client_id: o.clientId, client_secret: o.clientSecret, scopes }),
  } as SsoConnectionRecord);
}

/** The records an SSO-only route writes: the connection, and an organization when it belongs to one. */
export function connectionSet(connections: SsoConnectionRecord[], origin: string, organization?: { id: string; name: string }): RecordSet {
  const set = new RecordSet();
  set.manifest = { origin };
  if (organization) set.add('organization', { id: organization.id, name: organization.name, slug: slug(organization.name) }, organization.id);
  for (const c of connections) set.add('sso_connection', organization ? { ...c, organization_id: organization.id } : c, c.id);
  return set;
}

export type { Obj };
