import type { ParityRequest } from './parity';

/**
 * Parity requests for the round-four federation routes: the SAML artifact binding (the identity provider's resolution service and
 * the service provider's assertion consumer, refused paths only: a real exchange needs an identity provider), configuration
 * snapshots and environment clones. Clones are created with a platform key on a real instance; the group `platform` selects them.
 */
const q = (id: string, method: ParityRequest['method'], path: string, rest: Partial<ParityRequest> = {}): ParityRequest => ({ id, method, path, group: 'federation', ...rest });
const clones = '/v1/platform/apps/{{e4app}}/instances/{{e4ins}}/clones';
const CLONE_FIELDS = ['progress', 'counts', 'errors', 'expires_at', 'created_by', 'completed_at', 'deleted_at', 'allowed_origins', 'frontend_api_host', 'publishable_key', 'instance_id', 'secret', 'secret_key_scopes', 'note', 'replayed'];

export const emu4FederationParityRequests: ParityRequest[] = [
  // ── SAML artifact binding ──
  q('e4f idp metadata', 'GET', '/v1/saml/idp/metadata', { anonymous: true }),
  q('e4f idp artifact refused', 'POST', '/v1/saml/idp/artifact', { anonymous: true, body: {} }),
  q('e4f sp metadata unknown', 'GET', '/v1/sso/saml/e4-unknown/metadata', { anonymous: true }),
  q('e4f acs post empty', 'POST', '/v1/sso/saml/acs', { anonymous: true, form: { RelayState: 'e4-unknown' } }),
  q('e4f acs artifact unknown', 'GET', '/v1/sso/saml/acs?SAMLart=AAQAAA&RelayState=e4-unknown', { anonymous: true }),
  // ── configuration snapshots ──
  q('e4f snapshot create', 'POST', '/v1/instance/config_snapshots', { body: { label: 'Parity {{rand}}' }, capture: { e4s: 'id' }, tolerate: ['redacted_paths', 'created_by'] }),
  q('e4f snapshots', 'GET', '/v1/instance/config_snapshots?limit=5', { tolerate: ['data'] }),
  q('e4f snapshot get', 'GET', '/v1/instance/config_snapshots/{{e4s}}', { tolerate: ['auth_config', 'allowed_origins', 'redacted_paths', 'created_by'] }),
  q('e4f snapshot diff', 'GET', '/v1/instance/config_snapshots/diff?from={{e4s}}&to=current', { tolerate: ['changes', 'allowed_origins'] }),
  q('e4f snapshot restore preview', 'POST', '/v1/instance/config_snapshots/{{e4s}}/restore', { body: { dry_run: true }, tolerate: ['changes'] }),
  q('e4f snapshot delete', 'DELETE', '/v1/instance/config_snapshots/{{e4s}}'),
  // ── clones and previews (platform key) ──
  q('e4f instance', 'GET', '/v1/instance', { group: 'platform', capture: { e4ins: 'id', e4app: 'application_id' }, tolerate: ['id', 'application_id'] }),
  q('e4f clone create', 'POST', clones, { group: 'platform', body: { mode: 'preview', ref: 'pr-{{rand}}', ttl_hours: 1 }, capture: { e4c: 'id' }, tolerate: CLONE_FIELDS }),
  q('e4f clones', 'GET', `${clones}?kind=preview`, { group: 'platform', tolerate: ['data'] }),
  q('e4f clone get', 'GET', `${clones}/{{e4c}}`, { group: 'platform', tolerate: CLONE_FIELDS }),
  q('e4f clone delete', 'DELETE', `${clones}/{{e4c}}`, { group: 'platform', tolerate: CLONE_FIELDS }),
];
