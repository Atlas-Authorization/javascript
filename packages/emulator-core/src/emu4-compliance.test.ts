/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, expect, it } from 'vitest';
import { client, makeEngine } from './test-support';
import type { Engine } from './engine';

const events = (e: Engine, type: string) => e.webhooks.events.filter((x) => x.type === type);
const setup = () => {
  const e = makeEngine();
  return { e, call: client(e), anon: client(e, null) };
};
const config = (call: ReturnType<typeof client>, patch: Record<string, unknown>) => call('PUT', '/__emulator/compliance/config', patch);
const mkUser = async (call: ReturnType<typeof client>, email: string, extra: Record<string, unknown> = {}) => (await call('POST', '/v1/users', { email_address: email, ...extra })).json;

describe('compliance configuration', () => {
  it('validates a patch like a configuration write and keeps the defaults', async () => {
    const { call } = setup();
    const def = (await call('GET', '/__emulator/compliance/config')).json;
    expect(def.compliance.minors.consentMethods).toEqual(['email_link', 'admin']);
    expect(def.compliance.cookieConsent.enabled).toBe(false);
    const bad = await config(call, { compliance: { minors: { consentMethods: ['carrier_pigeon'], extra: 1 }, cookieConsent: { repromptDays: -1 } } });
    expect(bad.status).toBe(400);
    expect(bad.json.errors[0].code).toBe('VALIDATION_FAILED');
    expect(bad.json.errors[0].message).toContain('consentMethods');
    expect((await config(call, { localization: { requireReview: 'yes' } })).status).toBe(400);
    expect((await call('GET', '/__emulator/compliance/config')).json.compliance.minors.consentMethods).toEqual(['email_link', 'admin']);
    const ok = await config(call, { compliance: { cookieConsent: { categories: ['analytics'] } } });
    expect(ok.json.compliance.cookieConsent.categories).toEqual(['necessary', 'analytics']);
  });
});

describe('age assurance and guardian consent', () => {
  const minorSetup = async () => {
    const s = setup();
    await config(s.call, { compliance: { minors: { enabled: true, defaultConsentAge: 16, trustedAgeMethods: ['id_document'] } } });
    const child = await mkUser(s.call, 'kid@example.com', { public_metadata: { birthdate: '2018-01-01' } });
    const guardian = await mkUser(s.call, 'parent@example.com');
    return { ...s, child, guardian };
  };

  it('records "over N" by method, never keeps evidence, and revokes', async () => {
    const { e, call, child } = await minorSetup();
    expect((await call('POST', `/v1/users/${child.id}/age_assurance`, { method: 'self_declared', over_age: 0 })).json.errors[0].param).toBe('over_age');
    expect((await call('POST', `/v1/users/${child.id}/age_assurance`, { method: 'telepathy', over_age: 18 })).json.errors[0].param).toBe('method');
    expect((await call('POST', `/v1/users/${child.id}/age_assurance`, { method: 'self_declared', over_age: 18, assurance_level: 'high' })).json.errors[0].param).toBe('assurance_level');
    expect((await call('POST', `/v1/users/${child.id}/age_assurance`, { method: 'self_declared', over_age: 18, evidence: 'selfie.png' })).json.errors[0].code).toBe('VALIDATION_FAILED');
    const rec = await call('POST', `/v1/users/${child.id}/age_assurance`, { method: 'payment_card', over_age: 18, provider: 'acme', reference: 'chk_1' });
    expect(rec.status).toBe(201);
    expect(rec.json).toMatchObject({ object: 'age_assurance', method: 'payment_card', level: 'medium', over_age: 18, status: 'valid', trusted: false, reference: 'chk_1' });
    expect(Object.keys(rec.json)).not.toContain('evidence');
    expect(events(e, 'user.age_assurance_recorded')).toHaveLength(1);
    const list = (await call('GET', `/v1/users/${child.id}/age_assurance`)).json;
    expect(list.data).toHaveLength(1);
    const revoked = await call('POST', `/v1/users/${child.id}/age_assurance/${rec.json.id}/revoke`, { reason: 'wrong person' });
    expect(revoked.json).toMatchObject({ status: 'revoked', revoked_reason: 'wrong person' });
    expect((await call('POST', `/v1/users/${child.id}/age_assurance/aa_missing/revoke`, {})).status).toBe(404);
  });

  it('a trusted method replaces the date of birth; id_document rests on an approved verification', async () => {
    const { call, child } = await minorSetup();
    expect((await call('POST', `/v1/users/${child.id}/minor_status/assess`)).json.status).toBe('consent_required');
    const noVerification = await call('POST', `/v1/users/${child.id}/age_assurance`, { method: 'id_document', over_age: 18 });
    expect(noVerification.json.errors[0].param).toBe('verification_id');
    const pending = (await call('POST', '/__emulator/compliance/identity_verifications', { user_id: child.id, status: 'pending' })).json;
    expect((await call('POST', `/v1/users/${child.id}/age_assurance`, { method: 'id_document', over_age: 18, verification_id: pending.id })).status).toBe(400);
    const approved = (await call('POST', '/__emulator/compliance/identity_verifications', { user_id: child.id })).json;
    const ok = await call('POST', `/v1/users/${child.id}/age_assurance`, { method: 'id_document', over_age: 18, verification_id: approved.id });
    expect(ok.json).toMatchObject({ level: 'high', trusted: true, verification_id: approved.id });
    const status = (await call('GET', `/v1/users/${child.id}/minor_status`)).json;
    expect(status.status).toBe('not_required');
    expect(status.age_assurance).toMatchObject({ over_age: 18, method: 'id_document', level: 'high' });
    // withdrawing it brings the profile back
    await call('POST', `/v1/users/${child.id}/age_assurance/${ok.json.id}/revoke`, {});
    expect((await call('GET', `/v1/users/${child.id}/minor_status`)).json.status).toBe('consent_required');
  });

  it('guardian consent: email link by default, other methods only when accepted and above the floor', async () => {
    const { e, call, anon, child, guardian } = await minorSetup();
    await call('POST', `/v1/users/${child.id}/minor_status/assess`);
    expect(events(e, 'user.parental_consent_required')).toHaveLength(1);
    const link = await call('POST', `/v1/users/${child.id}/guardians`, { guardian_user_id: guardian.id, relationship: 'mother', send_email: true });
    expect(link.status).toBe(201);
    expect(link.json).toMatchObject({ object: 'guardian_link', status: 'pending', guardian_email: 'parent@example.com', emailed: true });
    expect(link.json.consent_url).toContain('/hosted/parental-consent?token=gct_');
    expect(e.messages.messages.some((m) => m.to === 'parent@example.com' && String(m.link).includes('gct_'))).toBe(true);
    expect((await call('POST', `/v1/users/${child.id}/guardians`, { guardian_user_id: child.id })).json.errors[0].message).toContain('own guardian');
    expect((await call('POST', `/v1/users/${child.id}/guardians`, { relationship: 'x' })).status).toBe(400);
    expect((await call('POST', `/v1/users/${child.id}/guardians/${link.json.id}/approve`, { method: 'signed_form' })).json.errors[0].message).toContain('not in compliance.minors.consentMethods');
    expect((await call('POST', `/v1/users/${child.id}/guardians/${link.json.id}/approve`, { method: 'email_link' })).status).toBe(400);
    // the guardian opens the link
    const token = new URL(link.json.consent_url).searchParams.get('token')!;
    expect((await anon('GET', `/v1/parental_consent/${token}`)).json).toMatchObject({ object: 'parental_consent_request', guardian_email: 'parent@example.com' });
    expect((await anon('POST', `/v1/parental_consent/${token}`, { decision: 'maybe' })).status).toBe(400);
    const decided = await anon('POST', `/v1/parental_consent/${token}`, { decision: 'approve' });
    expect(decided.json).toMatchObject({ object: 'parental_consent', decision: 'approve', status: 'consented' });
    expect(decided.json.guardian_link).toMatchObject({ status: 'active', consent_method: 'email_link', assurance_level: 'low' });
    expect((await anon('GET', `/v1/parental_consent/${token}`)).status).toBe(404);
    expect(events(e, 'user.parental_consent_granted')).toHaveLength(1);
    // revoking the only active link puts consent back to required
    await call('DELETE', `/v1/users/${child.id}/guardians/${link.json.id}`);
    expect((await call('GET', `/v1/users/${child.id}/minor_status`)).json.status).toBe('consent_required');
    expect((await call('POST', `/v1/users/${child.id}/guardians/${link.json.id}/approve`, {})).status).toBe(409);
  });

  it('methods beyond email: floor, no email link when it falls below it, id_document needs the guardian verification', async () => {
    const { call, child, guardian } = await minorSetup();
    await config(call, { compliance: { minors: { consentMethods: ['signed_form', 'id_document', 'third_party'], minAssuranceLevel: 'medium' } } });
    await call('POST', `/v1/users/${child.id}/minor_status/assess`);
    const link = await call('POST', `/v1/users/${child.id}/guardians`, { guardian_user_id: guardian.id });
    expect(link.json.consent_url).toBeNull();
    expect((await call('POST', `/v1/users/${child.id}/guardians`, { guardian_user_id: guardian.id, send_email: true })).json.errors[0].param).toBe('send_email');
    // the default method (admin) is no longer accepted
    expect((await call('POST', `/v1/users/${child.id}/guardians/${link.json.id}/approve`, {})).json.errors[0].message).toContain('admin is not in');
    const low = await call('POST', `/v1/users/${child.id}/guardians/${link.json.id}/approve`, { method: 'third_party', assurance_level: 'low' });
    expect(low.json.errors[0].message).toContain('below compliance.minors.minAssuranceLevel');
    expect((await call('POST', `/v1/users/${child.id}/guardians/${link.json.id}/approve`, { method: 'id_document' })).json.errors[0].param).toBe('verification_id');
    expect((await call('POST', `/v1/users/${child.id}/guardians/${link.json.id}/approve`, { method: 'signed_form', verification_id: 'x' })).json.errors[0].param).toBe('verification_id');
    const idv = (await call('POST', '/__emulator/compliance/identity_verifications', { user_id: guardian.id })).json;
    const done = await call('POST', `/v1/users/${child.id}/guardians/${link.json.id}/approve`, { method: 'id_document', verification_id: idv.id, reference: 'doc-1', note: 'checked' });
    expect(done.json).toMatchObject({ status: 'active', consent_method: 'id_document', assurance_level: 'high', verification_id: idv.id, consent_reference: 'doc-1' });
    expect((await call('GET', `/v1/users/${child.id}/minor_status`)).json.status).toBe('consented');
    const audit = (await call('GET', '/__emulator/compliance/audit?action=user.guardian_consent_recorded')).json.data;
    expect(audit[0].metadata).toMatchObject({ method: 'id_document', assurance_level: 'high' });
  });
});

describe('cookie consent store', () => {
  const SUBJECT = 'visitor-0123456789abcdef';
  it('is off until enabled, then keeps a ledger that honors signals and asks again when the policy changes', async () => {
    const { call, anon } = setup();
    expect((await anon('GET', `/v1/client/cookie_consent?subject=${SUBJECT}`)).status).toBe(400);
    await config(call, { compliance: { cookieConsent: { enabled: true, policyVersion: 'v1', repromptDays: 30 } } });
    expect((await anon('GET', '/v1/client/cookie_consent?subject=short')).json.errors[0].param).toBe('subject');
    const fresh = (await anon('GET', `/v1/client/cookie_consent?subject=${SUBJECT}`, undefined, { 'sec-gpc': '1' })).json;
    expect(fresh).toMatchObject({ decided: false, reprompt: true, reprompt_reason: 'no_choice', signal_applied: 'gpc' });
    expect(fresh.categories).toEqual({ necessary: true, functional: false, analytics: false, marketing: false });
    expect((await anon('POST', '/v1/client/cookie_consent', { subject: SUBJECT, categories: { nope: true } })).json.errors[0].param).toBe('categories.nope');
    expect((await anon('POST', '/v1/client/cookie_consent', { subject: SUBJECT, categories: { analytics: 'yes' } })).status).toBe(400);
    const rec = await anon('POST', '/v1/client/cookie_consent', { subject: SUBJECT, categories: { functional: true, analytics: true }, policy_version: 'v1', locale: 'fr' }, { 'idempotency-key': 'k1' });
    expect(rec.status).toBe(201);
    expect(rec.json).toMatchObject({ categories: { necessary: true, functional: true, analytics: true, marketing: false }, signal_applied: null, policy_version: 'v1', gpc: false, reprompt: false });
    expect((await anon('POST', '/v1/client/cookie_consent', { subject: SUBJECT, categories: {}, policy_version: 'v0' })).status).toBe(409);
    const gpc = await anon('POST', '/v1/client/cookie_consent', { subject: SUBJECT, categories: { analytics: true } }, { 'sec-gpc': '1' });
    expect(gpc.json).toMatchObject({ categories: { analytics: false, necessary: true }, gpc: true, signal_applied: 'gpc' });
    const e = (await anon('GET', `/v1/client/cookie_consent?subject=${SUBJECT}`)).json;
    expect(e).toMatchObject({ decided: true, reprompt: false });
    // a new policy version asks again
    await config(call, { compliance: { cookieConsent: { policyVersion: 'v2' } } });
    expect((await anon('GET', `/v1/client/cookie_consent?subject=${SUBJECT}`)).json).toMatchObject({ reprompt: true, reprompt_reason: 'policy_changed' });
    // a new category asks again too
    await config(call, { compliance: { cookieConsent: { policyVersion: 'v1', categories: ['functional', 'analytics', 'marketing', 'ads'] } } });
    expect((await anon('GET', `/v1/client/cookie_consent?subject=${SUBJECT}`)).json.reprompt_reason).toBe('categories_changed');
  });

  it('caps choices per visitor, reports a summary, links to a user and erases', async () => {
    const { e, call, anon } = setup();
    await config(call, { compliance: { cookieConsent: { enabled: true, honorDnt: true } } });
    for (let i = 0; i < 30; i++) expect((await anon('POST', '/v1/client/cookie_consent', { subject: SUBJECT, categories: { marketing: i % 2 === 0 } })).status).toBe(201);
    expect((await anon('POST', '/v1/client/cookie_consent', { subject: SUBJECT, categories: {} })).status).toBe(429);
    const other = 'other-visitor-0123456789';
    const dnt = await anon('POST', '/v1/client/cookie_consent', { subject: other, categories: { analytics: true } }, { dnt: '1' });
    expect(dnt.json).toMatchObject({ dnt: true, signal_applied: 'dnt', categories: { analytics: false } });
    expect(events(e, 'cookie_consent.recorded')).toHaveLength(31);
    expect(Object.keys((events(e, 'cookie_consent.recorded')[0]!.payload as any).data)).not.toContain('ip_anon');
    const summary = (await call('GET', '/v1/cookie_consents/summary?days=7')).json;
    expect(summary).toMatchObject({ object: 'cookie_consent_summary', enabled: true, days: 7, choices_recorded: 31, visitors: 2 });
    expect((await call('GET', '/v1/cookie_consents/summary?days=0')).status).toBe(400);
    const user = await mkUser(call, 'visitor@example.com');
    const session = (await call('POST', '/v1/sessions', { user_id: user.id })).json;
    const linked = await anon('POST', '/v1/client/me/cookie_consent/link', { subject: other }, { authorization: `Bearer ${session.jwt}` });
    expect(linked.json).toEqual({ object: 'cookie_consent_link', linked: 1 });
    expect((await call('GET', `/v1/cookie_consents?user_id=${user.id}`)).json.data).toHaveLength(1);
    expect((await call('GET', `/v1/cookie_consents/subjects/${other}`)).json).toMatchObject({ object: 'cookie_consent_subject', subject: other });
    expect((await call('GET', '/v1/cookie_consents/subjects/unknown-visitor-0123456')).status).toBe(404);
    expect((await call('DELETE', `/v1/users/${user.id}/cookie_consents`)).json).toEqual({ object: 'cookie_consent_erasure', removed: 1 });
    expect((await call('DELETE', `/v1/cookie_consents/subjects/${SUBJECT}`)).json.removed).toBe(30);
    expect((await anon('DELETE', `/v1/client/cookie_consent?subject=${SUBJECT}`)).json).toMatchObject({ removed: 0 });
  });

  it('retention removes old records', async () => {
    const { call, anon } = setup();
    await config(call, { compliance: { cookieConsent: { enabled: true, retentionDays: 30 } } });
    await anon('POST', '/v1/client/cookie_consent', { subject: SUBJECT, categories: {} });
    await call('POST', '/__emulator/time/advance', { ms: 31 * 86_400_000 });
    expect((await call('POST', '/__emulator/compliance/cookie_consent/sweep')).json).toMatchObject({ retention_days: 30, removed: 1 });
  });
});

describe('data rights board and downstream erasure', () => {
  const dsr = async (call: ReturnType<typeof client>, userId: string, type = 'erasure') => (await call('POST', '/v1/data_subject_requests', { user_id: userId, type })).json;

  it('triages requests and keeps notes', async () => {
    const { e, call } = setup();
    const u = await mkUser(call, 'a@example.com');
    const r = await dsr(call, u.id, 'access');
    expect(r).toMatchObject({ assignee: null, priority: 'normal', labels: [] });
    expect((await call('PATCH', `/v1/data_subject_requests/${r.id}/triage`, {})).status).toBe(400);
    expect((await call('PATCH', `/v1/data_subject_requests/${r.id}/triage`, { priority: 'asap' })).json.errors[0].param).toBe('priority');
    expect((await call('PATCH', `/v1/data_subject_requests/${r.id}/triage`, { labels: ['Bad Label'] })).json.errors[0].param).toBe('labels');
    const t = await call('PATCH', `/v1/data_subject_requests/${r.id}/triage`, { assignee: 'dpo', priority: 'urgent', labels: ['vip', 'vip'] });
    expect(t.json).toMatchObject({ assignee: 'dpo', priority: 'urgent', labels: ['vip'] });
    const board = (await call('GET', '/v1/dsr_console/summary')).json;
    expect(board).toMatchObject({ object: 'dsr_console_summary', open: 1, unassigned: 0, overdue: 0 });
    expect((await call('GET', '/v1/dsr_console/requests?assignee=dpo&priority=urgent&label=vip')).json.data).toHaveLength(1);
    expect((await call('GET', '/v1/dsr_console/requests?unassigned=true')).json.data).toHaveLength(0);
    expect((await call('GET', '/v1/dsr_console/requests?due_within_days=999')).status).toBe(400);
    const n = await call('POST', `/v1/data_subject_requests/${r.id}/notes`, { body: 'Called the user.' });
    expect(n.status).toBe(201);
    expect((await call('POST', `/v1/data_subject_requests/${r.id}/notes`, { body: '' })).status).toBe(400);
    expect((await call('GET', `/v1/data_subject_requests/${r.id}/notes`)).json.data).toHaveLength(1);
    e.clock.advance(40 * 86_400_000);
    expect((await call('GET', '/v1/dsr_console/summary')).json.overdue).toBe(1);
    expect((await call('GET', '/v1/dsr_console/requests?overdue=true')).json.data).toHaveLength(1);
  });

  it('connectors: catalog, validation, modes, and a key that is never echoed', async () => {
    const { call } = setup();
    expect((await call('GET', '/v1/erasure_connector_catalog')).json.data).toHaveLength(24);
    const bad = await call('POST', '/v1/erasure_connectors', { catalog_id: 'stripe', mode: 'api' });
    expect(bad.json.errors[0].param).toBe('credential');
    expect((await call('POST', '/v1/erasure_connectors', { key: 'x', name: 'X', mode: 'api', vendor: 'zendesk', credential: 'k' })).json.errors[0].param).toBe('config');
    expect((await call('POST', '/v1/erasure_connectors', { key: 'x', name: 'X', mode: 'manual', credential: 'k' })).json.errors[0].param).toBe('credential');
    const made = await call('POST', '/v1/erasure_connectors', { catalog_id: 'stripe', mode: 'api', credential: 'sk_live_secret_value' });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ key: 'stripe', name: 'Stripe', mode: 'api', vendor: 'stripe', has_credential: true });
    expect(JSON.stringify(made.json)).not.toContain('secret_value');
    expect((await call('POST', '/v1/erasure_connectors', { catalog_id: 'stripe', mode: 'manual' })).status).toBe(409);
    expect(JSON.stringify((await call('GET', `/v1/erasure_connectors/${made.json.id}`)).json)).not.toContain('secret_value');
    expect(JSON.stringify((await call('GET', '/v1/erasure_connectors')).json)).not.toContain('secret_value');
    const ack = await call('POST', '/v1/erasure_connectors', { key: 'search', name: 'Search', mode: 'ack' });
    expect(ack.json.ack_source).toBe('search');
    const patched = await call('PATCH', `/v1/erasure_connectors/${made.json.id}`, { notes: 'n', enabled: false });
    expect(patched.json).toMatchObject({ notes: 'n', enabled: false, has_credential: true });
    expect((await call('PATCH', `/v1/erasure_connectors/${made.json.id}`, { key: 'other' })).status).toBe(400);
    expect((await call('DELETE', `/v1/erasure_connectors/${made.json.id}`)).status).toBe(204);
    expect((await call('GET', `/v1/erasure_connectors/${made.json.id}`)).status).toBe(404);
  });

  it('an erasure runs the api connectors per request, records failures, and can be retried or dry-run', async () => {
    const { call } = setup();
    const u = await mkUser(call, 'erase.me@example.com');
    const api = (await call('POST', '/v1/erasure_connectors', { catalog_id: 'stripe', mode: 'api', credential: 'sk_good' })).json;
    const seg = (await call('POST', '/v1/erasure_connectors', { catalog_id: 'segment', mode: 'api', credential: 'sk_good' })).json;
    const manual = (await call('POST', '/v1/erasure_connectors', { key: 'crm', name: 'CRM', mode: 'manual' })).json;
    const ack = (await call('POST', '/v1/erasure_connectors', { key: 'search', name: 'Search', mode: 'ack' })).json;
    await call('PUT', '/__emulator/compliance/erasure_vendors/stripe', { valid_keys: ['sk_good'], records: { 'erase.me@example.com': 2 } });
    await call('PUT', '/__emulator/compliance/erasure_vendors/segment', { fail_status: 503, records: { [u.id]: 5 } });
    const r = await dsr(call, u.id);
    // probe: read-only
    expect((await call('POST', `/v1/erasure_connectors/${api.id}/probe`)).json).toMatchObject({ ok: true, vendor: 'stripe', error: null });
    expect((await call('POST', `/v1/erasure_connectors/${manual.id}/probe`)).status).toBe(400);
    expect((await call('GET', '/__emulator/compliance/erasure_vendors/stripe/calls')).json.data.at(-1)).toMatchObject({ action: 'probe', status: 200 });
    // a dry run says what it would do and deletes nothing
    const dry = (await call('POST', `/v1/data_subject_requests/${r.id}/downstream/${api.id}/run`, { dry_run: true })).json;
    expect(dry.results[0]).toMatchObject({ status: 'dry_run', vendor: 'stripe' });
    expect(dry.results[0].note).toContain('Nothing was deleted');
    expect((await call('GET', `/v1/data_subject_requests/${r.id}/downstream`)).json.connectors.find((x: any) => x.key === 'stripe')).toMatchObject({ status: 'pending', attempts: 0 });
    // fulfilling the erasure runs them; one failing never blocks it
    const fulfilled = await call('POST', `/v1/data_subject_requests/${r.id}/fulfill`);
    expect(fulfilled.json.status).toBe('completed');
    const down = (await call('GET', `/v1/data_subject_requests/${r.id}/downstream`)).json;
    expect(down.complete).toBe(false);
    expect(down.failed).toBe(1);
    expect(down.connectors.find((x: any) => x.key === 'stripe')).toMatchObject({ status: 'done', by: 'automatic', attempts: 1, note: 'Stripe: 2 records erased.' });
    expect(down.connectors.find((x: any) => x.key === 'segment')).toMatchObject({ status: 'failed', error: 'Segment returned HTTP 503.', attempts: 1 });
    expect(down.connectors.find((x: any) => x.key === 'crm')).toMatchObject({ status: 'pending', by: null });
    // the vendor holds nothing now and the key never appears in the call log
    const calls = JSON.stringify((await call('GET', '/__emulator/compliance/erasure_vendors/stripe/calls')).json);
    expect(calls).not.toContain('sk_good');
    // retry: the failing vendor recovers; the done one is not run again
    await call('PUT', '/__emulator/compliance/erasure_vendors/segment', { fail_status: null });
    const retried = (await call('POST', `/v1/data_subject_requests/${r.id}/downstream/${seg.id}/run`)).json;
    expect(retried.results[0]).toMatchObject({ status: 'done', note: 'Segment: 5 records erased.' });
    expect(retried.downstream.connectors.find((x: any) => x.key === 'segment')).toMatchObject({ status: 'done', attempts: 2 });
    const again = (await call('POST', `/v1/data_subject_requests/${r.id}/downstream/${api.id}/run`)).json;
    expect(again.results).toEqual([]);
    // manual and ack connectors close the loop
    expect((await call('POST', `/v1/data_subject_requests/${r.id}/downstream/${ack.id}`, {})).status).toBe(400);
    expect((await call('POST', `/v1/data_subject_requests/${r.id}/downstream/${manual.id}`, { status: 'maybe' })).status).toBe(400);
    await call('POST', `/v1/data_subject_requests/${r.id}/downstream/${manual.id}`, { status: 'done', note: 'Deleted by hand' });
    await call('POST', '/__emulator/compliance/erasure_acks', { user_id: u.id, source: 'search' });
    const complete = (await call('GET', `/v1/data_subject_requests/${r.id}/downstream`)).json;
    expect(complete).toMatchObject({ complete: true, pending: 0, failed: 0 });
    expect(complete.connectors.find((x: any) => x.key === 'search')).toMatchObject({ status: 'done', by: 'acknowledgement' });
    expect((await call('POST', `/v1/data_subject_requests/${r.id}/downstream/${manual.id}/run`)).status).toBe(400);
    expect((await call('GET', '/__emulator/compliance/audit?action=erasure_connector.run')).json.data.length).toBeGreaterThanOrEqual(3);
  });

  it('a vendor that refuses the key is reported as a refusal, not a crash', async () => {
    const { call } = setup();
    const u = await mkUser(call, 'refused@example.com');
    const api = (await call('POST', '/v1/erasure_connectors', { catalog_id: 'hubspot', mode: 'api', credential: 'bad-key' })).json;
    await call('PUT', '/__emulator/compliance/erasure_vendors/hubspot', { valid_keys: ['other'] });
    expect((await call('POST', `/v1/erasure_connectors/${api.id}/probe`)).json).toMatchObject({ ok: false, error: 'HubSpot refused the key (HTTP 401).' });
    const r = await dsr(call, u.id);
    const dry = (await call('POST', `/v1/data_subject_requests/${r.id}/downstream/${api.id}/run`, { dry_run: true })).json;
    expect(dry.results[0]).toMatchObject({ status: 'dry_run', error: 'HubSpot refused the key (HTTP 401).' });
    const access = await dsr(call, u.id, 'access');
    expect((await call('POST', `/v1/data_subject_requests/${access.id}/downstream/${api.id}/run`)).json.errors[0].param).toBe('id');
  });

  it('an erasure also removes the cookie choices linked to the user', async () => {
    const { call, anon } = setup();
    await config(call, { compliance: { cookieConsent: { enabled: true } } });
    const u = await mkUser(call, 'cookie.user@example.com');
    const jwt = (await call('POST', '/v1/sessions', { user_id: u.id })).json.jwt;
    await anon('POST', '/v1/client/cookie_consent', { subject: 'cookie-subject-0123456789', categories: {} });
    await anon('POST', '/v1/client/me/cookie_consent/link', { subject: 'cookie-subject-0123456789' }, { authorization: `Bearer ${jwt}` });
    expect((await call('GET', `/v1/cookie_consents?user_id=${u.id}`)).json.data).toHaveLength(1);
    const r = await dsr(call, u.id);
    await call('POST', `/v1/data_subject_requests/${r.id}/fulfill`);
    expect((await call('GET', '/v1/cookie_consents')).json.data).toHaveLength(0);
  });
});

describe('compliance reports', () => {
  it('builds the posture and record of processing from configuration, and signs a kept report', async () => {
    const { e, call } = setup();
    const empty = (await call('GET', '/v1/compliance/ropa')).json;
    expect(empty.findings.map((f: any) => f.code)).toEqual(['controller_missing', 'no_activities']);
    expect((await config(call, { compliance: { dataPolicy: { activities: [{ key: 'Bad Key' }] } } })).status).toBe(400);
    await config(call, { compliance: { dataPolicy: { controller: { name: 'Acme Ltd', contactEmail: 'privacy@acme.test' }, activities: [{ key: 'accounts', name: 'Accounts', purpose: 'Run the service', legalBasis: 'consent', transfersTo: ['US'], retentionDays: null }] }, cookieConsent: { enabled: true }, dataRegion: 'eu' } });
    const ropa = (await call('GET', '/v1/compliance/ropa')).json;
    expect(ropa.controller.name).toBe('Acme Ltd');
    expect(ropa.findings.map((f: any) => f.code)).toEqual(['no_retention', 'transfer_without_recipient']);
    const posture = (await call('GET', '/v1/compliance/posture')).json;
    expect(posture.controls.find((c: any) => c.id === 'record_of_processing').status).toBe('configured');
    expect(posture.controls.find((c: any) => c.id === 'data_region').detail).toBe('eu');
    expect(posture.data_rights).toMatchObject({ open: 0, overdue: 0 });
    expect((await call('POST', '/v1/compliance/reports', { kind: 'audit' })).json.errors[0].param).toBe('kind');
    const rep = await call('POST', '/v1/compliance/reports', { kind: 'ropa' });
    expect(rep.status).toBe(201);
    expect(rep.json.claims.controller.name).toBe('Acme Ltd');
    const verified = await e.tokens.verifyAny(rep.json.report);
    expect(verified.ok).toBe(true);
    expect(rep.json.jwks_uri).toContain('/.well-known/jwks.json');
    expect(events(e, 'compliance.report_generated')).toHaveLength(1);
    expect((await call('GET', '/v1/compliance/reports?kind=ropa')).json.data).toHaveLength(1);
    expect((await call('GET', '/v1/compliance/reports?kind=ropa')).json.data[0].report).toBeUndefined();
    expect((await call('GET', `/v1/compliance/reports/${rep.json.id}`)).json.report).toBe(rep.json.report);
  });

  it('previews who the inactive-user policy would act on', async () => {
    const { e, call } = setup();
    await config(call, { compliance: { inactiveUsers: { enabled: true, afterDays: 100, warnDays: 20, action: 'ban' } } });
    await mkUser(call, 'old@example.com');
    e.clock.advance(85 * 86_400_000);
    await mkUser(call, 'recent@example.com');
    let p = (await call('GET', '/v1/compliance/inactive_users/preview')).json;
    expect(p).toMatchObject({ enabled: true, action: 'ban', after_days: 100, warn_days: 20 });
    expect(p.would_warn).toHaveLength(1);
    expect(p.would_act).toHaveLength(0);
    e.clock.advance(20 * 86_400_000);
    p = (await call('GET', '/v1/compliance/inactive_users/preview')).json;
    expect(p.would_act).toHaveLength(1);
    expect((await config(call, { compliance: { inactiveUsers: { afterDays: 10 } } })).status).toBe(400);
  });
});

describe('policies: audience, translations, versions', () => {
  const policy = async (call: ReturnType<typeof client>, key = 'terms') => {
    const p = (await call('POST', '/v1/policies', { key, title: 'Terms' })).json;
    const v = (await call('POST', `/v1/policies/${p.id}/versions`, { version: '1', content_markdown: 'Be kind.' })).json;
    return { p, v };
  };

  it('an audience of chosen organizations leaves the policy off the public list', async () => {
    const { call, anon } = setup();
    const { p, v } = await policy(call);
    expect(v.status).toBe('draft');
    await call('POST', `/v1/policies/${p.id}/versions/${v.id}/publish`);
    expect((await anon('GET', '/v1/client/policies')).json.data.map((x: any) => x.key)).toEqual(['terms']);
    expect((await call('GET', `/v1/policies/${p.id}/audience`)).json).toMatchObject({ audience: 'everyone', organization_ids: [] });
    expect((await call('PUT', `/v1/policies/${p.id}/audience`, { audience: 'orgs' })).json.errors[0].param).toBe('organization_ids');
    expect((await call('PUT', `/v1/policies/${p.id}/audience`, { audience: 'orgs', organization_ids: ['org_missing'] })).json.errors[0].message).toContain('Unknown organization');
    expect((await call('PUT', `/v1/policies/${p.id}/audience`, { audience: 'everyone', organization_ids: ['org_1'] })).status).toBe(400);
    const org = (await call('POST', '/v1/organizations', { name: 'Acme' })).json;
    const set = await call('PUT', `/v1/policies/${p.key}/audience`, { audience: 'orgs', organization_ids: [org.id, org.id] });
    expect(set.json).toMatchObject({ audience: 'orgs', organization_ids: [org.id], policy: 'terms' });
    expect((await anon('GET', '/v1/client/policies')).json.data).toEqual([]);
    await call('PUT', `/v1/policies/${p.id}/audience`, { audience: 'everyone' });
    expect((await anon('GET', '/v1/client/policies')).json.data).toHaveLength(1);
    expect((await call('GET', '/__emulator/compliance/audit?action=policy.audience_changed')).json.data).toHaveLength(2);
  });

  it('translations: a draft can be edited, a published version only gains languages; the nearest language is served with its own hash', async () => {
    const { e, call, anon } = setup();
    const { p, v } = await policy(call);
    const base = `/v1/policies/${p.id}/versions/${v.id}/translations`;
    expect((await call('PUT', `${base}/not_a_locale`, { content_markdown: 'x' })).json.errors[0].param).toBe('locale');
    expect((await call('PUT', `${base}/es`, {})).json.errors[0].param).toBe('content_markdown');
    expect((await call('PUT', `${base}/es`, { content_markdown: 'a', content_html: '<p>a</p>' })).status).toBe(400);
    const es = await call('PUT', `${base}/es-mx`, { title: 'Terminos', content_markdown: 'Se amable.' });
    expect(es.json).toMatchObject({ locale: 'es-MX', title: 'Terminos', policy: 'terms' });
    expect(es.json.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    const html = await call('PUT', `${base}/fr`, { content_html: '<p onclick="x()">Soyez gentil</p><script>alert(1)</script>' });
    expect(html.json.content_html).toBe('<p>Soyez gentil</p>');
    const es2 = await call('PUT', `${base}/es-MX`, { content_markdown: 'Se muy amable.' });
    expect(es2.status).toBe(200);
    await call('POST', `/v1/policies/${p.id}/versions/${v.id}/publish`);
    expect(events(e, 'policy.version_published')).toHaveLength(1);
    expect((await call('POST', `/v1/policies/${p.id}/versions/${v.id}/publish`)).status).toBe(409);
    expect((await call('PUT', `${base}/es-MX`, { content_markdown: 'Cambiado.' })).status).toBe(409);
    expect((await call('PUT', `${base}/de`, { content_markdown: 'Sei nett.' })).status).toBe(200);
    expect((await call('DELETE', `${base}/de`)).status).toBe(409);
    const served = (await anon('GET', '/v1/client/policies?locale=es')).json.data[0];
    expect(served).toMatchObject({ locale: 'es-MX', title: 'Terms', available_locales: expect.arrayContaining(['es-MX', 'fr', 'de']) });
    expect(served.content_sha256).toBe(es2.json.content_sha256);
    expect(served.content_sha256).not.toBe(es.json.content_sha256);
    const base2 = (await anon('GET', '/v1/client/policies')).json.data[0];
    expect(base2.locale).not.toBe('es-MX');
    expect(base2.available_locales).toHaveLength(3);
    expect((await call('GET', base)).json.data).toHaveLength(3);
    expect((await call('GET', `/v1/policies/${p.id}/versions/${v.id}x/translations`)).status).toBe(404);
  });
});

describe('translation review', () => {
  const two = () => {
    const e = makeEngine({ secretKeys: [{ key: 'sk_writer' }, { key: 'sk_reviewer' }] });
    return { e, writer: client(e, 'sk_writer'), reviewer: client(e, 'sk_reviewer') };
  };
  const row = { resource_type: 'prompt_copy', resource_name: 'hosted', locale: 'fr', content: { headline: 'Bonjour {{name}}' } };

  it('moves draft to review to approved, with history, summary and a changed-since-approval flag', async () => {
    const { e, writer } = two();
    await writer('PUT', '/__emulator/compliance/config', { localization: { requireReview: true } });
    const created = (await writer('POST', '/v1/localizations', row)).json;
    expect(created).toMatchObject({ review_status: 'draft', reviewed_by: null, changed_since_approval: false });
    expect((await writer('POST', `/v1/localizations/${created.id}/review`, { action: 'approve' })).status).toBe(409);
    expect((await writer('POST', `/v1/localizations/${created.id}/review`, { action: 'nope' })).json.errors[0].param).toBe('action');
    expect((await writer('POST', `/v1/localizations/${created.id}/review`, { action: 'submit', note: 'Ready' })).json.review_status).toBe('in_review');
    expect((await writer('POST', `/v1/localizations/${created.id}/review`, { action: 'request_changes' })).json.errors[0].param).toBe('note');
    const changes = await writer('POST', `/v1/localizations/${created.id}/review`, { action: 'request_changes', note: 'Use the formal form' });
    expect(changes.json.review_status).toBe('changes_requested');
    // editing the text while it waits sends it back to draft
    expect((await writer('PATCH', `/v1/localizations/${created.id}`, { content: { headline: 'Bonjour, {{name}}' } })).json.review_status).toBe('draft');
    await writer('POST', `/v1/localizations/${created.id}/review`, { action: 'submit' });
    const approved = (await writer('POST', `/v1/localizations/${created.id}/review`, { action: 'approve', reviewer_hint: 'a French speaker' })).json;
    expect(approved).toMatchObject({ review_status: 'approved', reviewed_by: expect.stringMatching(/^apikey_/), reviewer_hint: 'a French speaker', changed_since_approval: false });
    expect(events(e, 'localization.review_decided').map((x) => (x.payload as any).data.review_status)).toEqual(['in_review', 'changes_requested', 'in_review', 'approved']);
    const history = (await writer('GET', `/v1/localizations/${created.id}/reviews`)).json.data;
    expect(history.map((h: any) => h.action)).toEqual(['approve', 'submit', 'request_changes', 'submit']);
    expect(history[0].content_hash).toMatch(/^[0-9a-f]{64}$/);
    // editing an approved text sends it back to draft (approval no longer stands)
    expect((await writer('PATCH', `/v1/localizations/${created.id}`, { content: { headline: 'Salut {{name}}' } })).json.review_status).toBe('draft');
    const summary = (await writer('GET', '/v1/localizations/review_summary')).json;
    expect(summary.counts).toEqual({ draft: 1, in_review: 0, changes_requested: 0, approved: 0 });
    expect((await writer('GET', `/v1/localizations/${created.id}`)).json.review_status).toBe('draft');
    expect((await writer('GET', '/v1/localizations')).json.data[0].review_status).toBe('draft');
    expect((await writer('GET', '/v1/localizations/loc_missing/reviews')).status).toBe(404);
  });

  it('without requireReview a new translation counts as approved (as every row did before review existed)', async () => {
    const { writer } = two();
    expect((await writer('POST', '/v1/localizations', row)).json.review_status).toBe('approved');
  });

  it('four eyes: the author cannot approve their own text', async () => {
    const { writer, reviewer } = two();
    await writer('PUT', '/__emulator/compliance/config', { localization: { requireReview: true, requireFourEyes: true } });
    const l = (await writer('POST', '/v1/localizations', row)).json;
    await writer('POST', `/v1/localizations/${l.id}/review`, { action: 'submit' });
    const own = await writer('POST', `/v1/localizations/${l.id}/review`, { action: 'approve' });
    expect(own.status).toBe(403);
    expect(own.json.errors[0].message).toContain('Four eyes');
    const other = await reviewer('POST', `/v1/localizations/${l.id}/review`, { action: 'approve' });
    expect(other.json.review_status).toBe('approved');
    expect(other.json.authored_by).not.toBe(other.json.reviewed_by);
    await writer('PUT', '/__emulator/compliance/config', { localization: { requireFourEyes: false } });
    const l2 = (await writer('POST', '/v1/localizations', { ...row, locale: 'de' })).json;
    await writer('POST', `/v1/localizations/${l2.id}/review`, { action: 'submit' });
    expect((await writer('POST', `/v1/localizations/${l2.id}/review`, { action: 'approve' })).status).toBe(200);
  });

  it('the CI check validates without saving and compares placeholders with approved siblings', async () => {
    const { writer } = two();
    await writer('POST', '/v1/localizations', { ...row, locale: 'es', content: { headline: 'Hola {{name}}' } });
    const check = (items: unknown[], extra: Record<string, unknown> = {}) => writer('POST', '/v1/localizations/check', { items, ...extra });
    expect((await check([])).status).toBe(400);
    const res = (await check([
      { ...row, content: { headline: 'Bonjour' } },
      { ...row, content: { headline: 'Bonjour {{name}}' } },
      { resource_type: 'prompt_copy', resource_name: 'wrong', locale: 'fr', content: { bogus: ' ' } },
      { resource_type: 'prompt_copy', resource_name: 'hosted', locale: 'not a locale', content: {} },
    ])).json;
    expect(res).toMatchObject({ object: 'localization_check', ok: false, checked: 4, failed: 3 });
    expect(res.results[0].problems[0].code).toBe('placeholder_mismatch');
    expect(res.results[1].ok).toBe(true);
    expect(res.results[2].problems.map((p: any) => p.code)).toEqual(expect.arrayContaining(['empty', 'unknown_resource', 'unknown_key']));
    expect(res.results[3].problems[0].code).toBe('locale');
    const strict = (await check([{ ...row, locale: 'es', content: { headline: 'Hola {{name}}' } }, { ...row, content: { headline: 'Bonjour {{name}}' } }], { require_approved: true })).json;
    expect(strict.results[0].ok).toBe(true);
    expect(strict.results[1].problems[0].code).toBe('not_stored');
    expect((await writer('GET', '/v1/localizations')).json.data).toHaveLength(1);
  });
});

describe('region', () => {
  it('is single-region by default: nothing to pin to', async () => {
    const { call } = setup();
    expect((await call('GET', '/v1/region')).json).toMatchObject({ object: 'region_status', region: null, pinned: false, regions_enabled: false, effective_fapi_isolation: 'off', regions: [] });
    expect((await call('PUT', '/v1/region', {})).status).toBe(400);
    expect((await call('PUT', '/v1/region', { pin: true })).json.errors[0].message).toContain('no region configured');
    expect((await call('PUT', '/v1/region', { fapi_isolation: 'enforce' })).json).toMatchObject({ fapi_isolation: 'enforce', effective_fapi_isolation: 'enforce' });
    expect((await call('PUT', '/v1/region', { fapi_isolation: 'sometimes' })).json.errors[0].param).toBe('fapi_isolation');
    expect((await call('GET', '/__emulator/region/decision')).json.serves).toBe(true);
  });

  it('pins to the stack answering, names a failover, refuses another stack with 421, and never unpins', async () => {
    const { call } = setup();
    const table = [{ id: 'eu', label: 'Europe', fapi_origin: 'https://eu.example.com', bapi_origin: 'https://api.eu.example.com' }, { id: 'us', label: 'United States', fapi_origin: 'https://us.example.com', failover_to: 'eu' }];
    expect((await call('PUT', '/__emulator/region/config', { self: 'ap', regions: table })).status).toBe(400);
    expect((await call('PUT', '/__emulator/region/config', { self: 'eu', regions: [{ id: 'eu', failover_to: 'zz' }] })).status).toBe(400);
    const cfg = (await call('PUT', '/__emulator/region/config', { self: 'eu', regions: table })).json;
    expect(cfg).toMatchObject({ regions_enabled: true, serving_region: 'eu' });
    expect(cfg.regions.find((r: any) => r.id === 'eu').self).toBe(true);
    expect((await call('PUT', '/v1/region', { failover_region: 'us' })).json.errors[0].message).toContain('Pin the instance');
    expect((await call('PUT', '/v1/region', { pin: false })).json.errors[0].message).toContain('cannot be unpinned');
    expect((await call('PUT', '/v1/region', { pin: true })).json).toMatchObject({ region: 'eu', pinned: true });
    expect((await call('PUT', '/v1/region', { failover_region: 'eu' })).json.errors[0].message).toContain('must differ');
    expect((await call('PUT', '/v1/region', { failover_region: 'xx' })).status).toBe(400);
    expect((await call('PUT', '/v1/region', { failover_region: 'us' })).json.failover_region).toBe('us');
    expect((await call('GET', '/v1/region/failover')).status).toBe(400);
    expect((await call('GET', '/v1/region/failover?mount_host=app.example.com&base_path=/Bad')).json.errors[0].param).toBe('base_path');
    const plan = (await call('GET', '/v1/region/failover?mount_host=app.example.com')).json;
    expect(plan).toMatchObject({ object: 'region_failover', base_path: '/__atlas' });
    expect(plan.upstreams.map((u: any) => u.role)).toEqual(['primary', 'failover']);
    expect(plan.nginx).toContain('proxy_next_upstream error timeout http_502 http_503 http_504');
    expect(plan.nginx).toContain('us.example.com');
    expect((await call('GET', '/__emulator/compliance/audit?action=instance.region_updated')).json.data).toHaveLength(2);
    // the stack answering is another region: refused, naming where the instance lives
    await call('PUT', '/__emulator/region/config', { self: 'us' });
    expect((await call('GET', '/v1/region')).status).toBe(200); // its failover region may serve it
    await call('PUT', '/__emulator/region/config', { self: 'eu', regions: [...table, { id: 'ap', fapi_origin: 'https://ap.example.com' }] });
    await call('PUT', '/v1/region', { failover_region: null });
    await call('PUT', '/__emulator/region/config', { self: 'ap' });
    const refused = await call('GET', '/v1/region');
    expect(refused.status).toBe(421);
    expect(refused.json.errors[0]).toMatchObject({ code: 'WRONG_REGION', meta: { region: 'eu', fapi_origin: 'https://eu.example.com', bapi_origin: 'https://api.eu.example.com' } });
    expect((await call('PUT', '/v1/region', { fapi_isolation: 'off' })).status).toBe(421);
    expect((await call('GET', '/__emulator/region/decision')).json).toMatchObject({ serves: false, pinned: 'eu' });
  });
});
