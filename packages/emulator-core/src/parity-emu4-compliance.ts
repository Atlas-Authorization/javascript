import type { ParityRequest } from './parity';

/**
 * Parity requests for the round-four compliance routes: age assurance and guardian consent, the cookie consent store, the data
 * rights board and downstream erasure connectors, signed reports, per-organization and per-language policies, translation review
 * and region. Each request builds its own users and policies. Settings-dependent answers (an off feature answers 400) are the same
 * shape on both sides; values that depend on configuration are tolerated.
 */
const q = (id: string, method: ParityRequest['method'], path: string, rest: Partial<ParityRequest> = {}): ParityRequest => ({ id, method, path, group: 'compliance', ...rest });
const asUser = { authorization: 'Bearer {{e4jwt}}' };
const pk = { 'x-publishable-key': '{{e4pk}}' };
const SUBJECT = 'e4-subject-{{rand}}-0123456789';

export const emu4ComplianceParityRequests: ParityRequest[] = [
  // ── fixtures ──
  q('e4c user', 'POST', '/v1/users', { body: { email_address: 'e4c-{{rand}}@example.com' }, capture: { e4u: 'id' } }),
  q('e4c guardian user', 'POST', '/v1/users', { body: { email_address: 'e4g-{{rand}}@example.com' }, capture: { e4g: 'id' } }),
  q('e4c erasure user', 'POST', '/v1/users', { body: { email_address: 'e4x-{{rand}}@example.com' }, capture: { e4x: 'id' } }),
  q('e4c org', 'POST', '/v1/organizations', { body: { name: 'Compliance {{rand}}' }, capture: { e4o: 'id' } }),
  q('e4c session', 'POST', '/v1/sessions', { body: { user_id: '{{e4u}}' }, capture: { e4jwt: 'jwt' }, tolerate: ['jwt', 'refresh_token'] }),
  q('e4c instance', 'GET', '/v1/instance', { capture: { e4pk: 'publishable_key' }, tolerate: ['publishable_key'] }),
  // ── age assurance and guardians ──
  q('e4 minor status', 'GET', '/v1/users/{{e4u}}/minor_status', { tolerate: ['age_assurance', 'guardians', 'birthdate', 'age_at_assessment', 'consent_age', 'jurisdiction', 'consented_at'] }),
  q('e4 minor assess', 'POST', '/v1/users/{{e4u}}/minor_status/assess', { tolerate: ['age_assurance', 'guardians', 'birthdate', 'age_at_assessment', 'consent_age', 'jurisdiction', 'consented_at', 'status', 'object', 'errors'] }),
  q('e4 age assurance record', 'POST', '/v1/users/{{e4u}}/age_assurance', { body: { method: 'self_declared', over_age: 13 }, capture: { e4aa: 'id' } }),
  q('e4 age assurance list', 'GET', '/v1/users/{{e4u}}/age_assurance', { tolerate: ['data'] }),
  q('e4 age assurance revoke', 'POST', '/v1/users/{{e4u}}/age_assurance/{{e4aa}}/revoke', { body: { reason: 'parity' } }),
  q('e4 guardian request', 'POST', '/v1/users/{{e4u}}/guardians', { body: { email: 'e4-guardian-{{rand}}@example.com', relationship: 'parent' }, capture: { e4gl: 'id', e4tok: 'consent_url' }, tolerate: ['consent_url', 'emailed', 'expires_at'] }),
  q('e4 guardian approve', 'POST', '/v1/users/{{e4u}}/guardians/{{e4gl}}/approve', { body: { method: 'admin', note: 'parity' }, tolerate: ['consent_method', 'assurance_level', 'consented_at', 'status', 'errors', 'object', 'id', 'child_user_id', 'guardian_user_id', 'guardian_email', 'relationship', 'expires_at', 'consent_reference', 'verification_id', 'created_at'] }),
  q('e4 guardian revoke', 'DELETE', '/v1/users/{{e4u}}/guardians/{{e4gl}}', { tolerate: ['consent_method', 'assurance_level', 'consented_at', 'expires_at', 'consent_reference', 'verification_id'] }),
  q('e4 parental consent page', 'GET', '/v1/parental_consent/e4-unknown-token', { anonymous: true }),
  q('e4 parental consent decide', 'POST', '/v1/parental_consent/e4-unknown-token', { anonymous: true, body: { decision: 'approve' } }),
  // ── cookie consent store ──
  q('e4 cookie state', 'GET', `/v1/client/cookie_consent?subject=${SUBJECT}`, { anonymous: true, headers: pk, tolerate: ['categories', 'config', 'recorded_at', 'reprompt_reason', 'policy_version', 'signal_applied', 'errors', 'object', 'enabled', 'subject', 'decided', 'reprompt'] }),
  q('e4 cookie record', 'POST', '/v1/client/cookie_consent', { anonymous: true, headers: pk, body: { subject: SUBJECT, categories: { functional: true, analytics: false } }, tolerate: ['categories', 'reprompt', 'errors', 'object', 'id', 'subject', 'user_id', 'policy_version', 'source', 'gpc', 'dnt', 'signal_applied', 'region', 'locale', 'created_at'] }),
  q('e4 cookie link', 'POST', '/v1/client/me/cookie_consent/link', { anonymous: true, headers: { ...asUser, ...pk }, body: { subject: SUBJECT }, tolerate: ['linked', 'errors', 'object'] }),
  q('e4 cookie ledger', 'GET', '/v1/cookie_consents', { tolerate: ['data'] }),
  q('e4 cookie summary', 'GET', '/v1/cookie_consents/summary', { tolerate: ['opted_in', 'policy_version'] }),
  q('e4 cookie subject', 'GET', `/v1/cookie_consents/subjects/${SUBJECT}`, { tolerate: ['current', 'history', 'errors', 'object', 'subject'] }),
  q('e4 cookie subject erase', 'DELETE', `/v1/cookie_consents/subjects/${SUBJECT}`, { tolerate: ['removed'] }),
  q('e4 cookie forget', 'DELETE', `/v1/client/cookie_consent?subject=${SUBJECT}`, { anonymous: true, headers: pk, tolerate: ['removed', 'subject', 'errors', 'object'] }),
  q('e4 user cookie erase', 'DELETE', '/v1/users/{{e4u}}/cookie_consents', { tolerate: ['removed'] }),
  // ── reports ──
  q('e4 posture', 'GET', '/v1/compliance/posture', { tolerate: ['controls', 'summary', 'data_rights', 'downstream_erasure', 'instance_id', 'generated_at'] }),
  q('e4 ropa', 'GET', '/v1/compliance/ropa', { tolerate: ['controller', 'activities', 'retention', 'atlas_sub_processors', 'findings', 'data_region', 'processor', 'instance_id', 'generated_at'] }),
  q('e4 report create', 'POST', '/v1/compliance/reports', { body: { kind: 'posture' }, capture: { e4rep: 'id' }, tolerate: ['claims', 'report', 'kid', 'jwks_uri', 'generated_by'] }),
  q('e4 report list', 'GET', '/v1/compliance/reports', { tolerate: ['data'] }),
  q('e4 report get', 'GET', '/v1/compliance/reports/{{e4rep}}', { tolerate: ['claims', 'report', 'kid', 'jwks_uri', 'generated_by'] }),
  q('e4 inactive preview', 'GET', '/v1/compliance/inactive_users/preview', { tolerate: ['would_act', 'would_warn'] }),
  // ── data rights board and downstream erasure ──
  q('e4 dsr', 'POST', '/v1/data_subject_requests', { body: { user_id: '{{e4x}}', type: 'erasure' }, capture: { e4d: 'id' }, tolerate: ['steps', 'retention', 'result', 'scheduled_for', 'eta', 'deletion_effective_at', 'status', 'due_at', 'overdue', 'assignee', 'priority', 'labels', 'case_id', 'external_case', 'trace_id', 'detail', 'reason', 'requested_by_id', 'completed_at', 'due_extended_reason', 'canonicalType'] }),
  q('e4 dsr summary', 'GET', '/v1/dsr_console/summary', { tolerate: ['by_status', 'oldest_open_at'] }),
  q('e4 dsr requests', 'GET', '/v1/dsr_console/requests?unassigned=true', { tolerate: ['data'] }),
  q('e4 dsr triage', 'PATCH', '/v1/data_subject_requests/{{e4d}}/triage', { body: { assignee: 'privacy-team', priority: 'high', labels: ['parity'] }, tolerate: ['steps', 'retention', 'result', 'scheduled_for', 'eta', 'deletion_effective_at', 'due_at', 'case_id', 'external_case', 'trace_id', 'detail', 'reason', 'requested_by_id', 'completed_at', 'due_extended_reason', 'canonicalType'] }),
  q('e4 dsr note', 'POST', '/v1/data_subject_requests/{{e4d}}/notes', { body: { body: 'Parity note' }, tolerate: ['author'] }),
  q('e4 dsr notes', 'GET', '/v1/data_subject_requests/{{e4d}}/notes', { tolerate: ['data'] }),
  q('e4 erasure catalog', 'GET', '/v1/erasure_connector_catalog', { tolerate: ['data'] }),
  q('e4 connector create', 'POST', '/v1/erasure_connectors', { body: { key: 'e4-{{rand}}', name: 'Parity system', mode: 'manual' }, capture: { e4ec: 'id' }, tolerate: ['catalog_id', 'ack_source', 'notes', 'vendor', 'config'] }),
  q('e4 connector list', 'GET', '/v1/erasure_connectors', { tolerate: ['data'] }),
  q('e4 connector get', 'GET', '/v1/erasure_connectors/{{e4ec}}', { tolerate: ['catalog_id', 'ack_source', 'notes', 'vendor', 'config'] }),
  q('e4 connector patch', 'PATCH', '/v1/erasure_connectors/{{e4ec}}', { body: { notes: 'Parity' }, tolerate: ['catalog_id', 'ack_source', 'notes', 'vendor', 'config'] }),
  q('e4 connector probe refused', 'POST', '/v1/erasure_connectors/{{e4ec}}/probe'),
  q('e4 downstream', 'GET', '/v1/data_subject_requests/{{e4d}}/downstream', { tolerate: ['connectors'] }),
  q('e4 downstream mark', 'POST', '/v1/data_subject_requests/{{e4d}}/downstream/{{e4ec}}', { body: { status: 'done', note: 'Erased by hand' }, tolerate: ['connectors'] }),
  q('e4 downstream run refused', 'POST', '/v1/data_subject_requests/{{e4d}}/downstream/{{e4ec}}/run', { body: { dry_run: true } }),
  q('e4 connector delete', 'DELETE', '/v1/erasure_connectors/{{e4ec}}'),
  // ── policies: audience, versions, translations ──
  q('e4 policy', 'POST', '/v1/policies', { body: { key: 'e4-terms-{{rand}}', title: 'Terms', display: 'checkbox' }, capture: { e4p: 'id' }, tolerate: ['current_version', 'upcoming_version', 'latest_version', 'overrides', 'audience'] }),
  q('e4 policy audience get', 'GET', '/v1/policies/{{e4p}}/audience'),
  q('e4 policy audience set', 'PUT', '/v1/policies/{{e4p}}/audience', { body: { audience: 'orgs', organization_ids: ['{{e4o}}'] }, tolerate: ['organization_ids'] }),
  q('e4 policy version', 'POST', '/v1/policies/{{e4p}}/versions', { body: { version: '1', content_markdown: 'Be kind.' }, capture: { e4v: 'id' }, tolerate: ['status', 'content_html', 'content_markdown', 'content_sha256', 'content_url', 'summary_of_changes', 'locale', 'published_at', 'effective_at', 'retired_at', 'created_at', 'updated_at', 'policy_id', 'policy'] }),
  q('e4 translation put', 'PUT', '/v1/policies/{{e4p}}/versions/{{e4v}}/translations/es', { body: { title: 'Terminos', content_markdown: 'Se amable.' }, tolerate: ['title', 'content_markdown', 'content_html', 'content_sha256', 'version', 'created_at', 'updated_at'] }),
  q('e4 translations list', 'GET', '/v1/policies/{{e4p}}/versions/{{e4v}}/translations', { tolerate: ['data'] }),
  q('e4 translation delete', 'DELETE', '/v1/policies/{{e4p}}/versions/{{e4v}}/translations/es'),
  q('e4 version publish', 'POST', '/v1/policies/{{e4p}}/versions/{{e4v}}/publish', { tolerate: ['status', 'content_html', 'content_markdown', 'content_sha256', 'content_url', 'summary_of_changes', 'locale', 'published_at', 'effective_at', 'retired_at', 'created_at', 'updated_at', 'policy_id', 'policy', 'version'] }),
  q('e4 client policies', 'GET', '/v1/client/policies?locale=es', { anonymous: true, headers: pk, tolerate: ['data', 'legacy_consent'] }),
  q('e4 version retire', 'POST', '/v1/policies/{{e4p}}/versions/{{e4v}}/retire', { tolerate: ['status', 'content_html', 'content_markdown', 'content_sha256', 'content_url', 'summary_of_changes', 'locale', 'published_at', 'effective_at', 'retired_at', 'created_at', 'updated_at', 'policy_id', 'policy', 'version'] }),
  // ── translation review ──
  q('e4 localization', 'POST', '/v1/localizations', { body: { resource_type: 'prompt_copy', resource_name: 'hosted', locale: 'fr', content: { headline: 'Bonjour {{name}}' } }, capture: { e4l: 'id' }, tolerate: ['authored_by', 'reviewed_by', 'reviewed_at', 'reviewer_hint', 'changed_since_approval', 'review_status'] }),
  q('e4 localization get', 'GET', '/v1/localizations/{{e4l}}', { tolerate: ['authored_by', 'reviewed_by', 'reviewed_at', 'reviewer_hint', 'changed_since_approval', 'review_status'] }),
  q('e4 localization list', 'GET', '/v1/localizations', { tolerate: ['data'] }),
  q('e4 localization patch', 'PATCH', '/v1/localizations/{{e4l}}', { body: { content: { headline: 'Salut {{name}}' } }, tolerate: ['authored_by', 'reviewed_by', 'reviewed_at', 'reviewer_hint', 'changed_since_approval', 'review_status'] }),
  q('e4 localization submit', 'POST', '/v1/localizations/{{e4l}}/review', { body: { action: 'submit', note: 'Ready' }, tolerate: ['authored_by', 'reviewed_by', 'reviewed_at', 'reviewer_hint', 'changed_since_approval', 'review_status', 'content', 'enabled', 'errors', 'object', 'id', 'resource_type', 'resource_name', 'locale', 'created_at', 'updated_at'] }),
  q('e4 localization reviews', 'GET', '/v1/localizations/{{e4l}}/reviews', { tolerate: ['data'] }),
  q('e4 localization summary', 'GET', '/v1/localizations/review_summary', { tolerate: ['counts', 'queue', 'changed_since_approval'] }),
  q('e4 localization check', 'POST', '/v1/localizations/check', { body: { items: [{ resource_type: 'prompt_copy', resource_name: 'hosted', locale: 'fr', content: { headline: 'Bonjour' } }] }, tolerate: ['results'] }),
  // ── region ──
  q('e4 region', 'GET', '/v1/region', { tolerate: ['region', 'pinned', 'serving_region', 'regions_enabled', 'failover_region', 'fapi_isolation', 'effective_fapi_isolation', 'regions'] }),
  q('e4 region set', 'PUT', '/v1/region', { body: { fapi_isolation: null }, tolerate: ['region', 'pinned', 'serving_region', 'regions_enabled', 'failover_region', 'fapi_isolation', 'effective_fapi_isolation', 'regions'] }),
  q('e4 region failover', 'GET', '/v1/region/failover?mount_host=app.example.com', { tolerate: ['upstreams', 'nginx', 'caddy', 'mount_host', 'base_path', 'object', 'errors'] }),
];
