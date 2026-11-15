/* eslint-disable @typescript-eslint/no-explicit-any */
import { X509Certificate, createHash, createSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { client, makeEngine } from './test-support';
import type { Engine } from './engine';

const raw = async (e: Engine, method: string, path: string, body?: string) => {
  const res = await e.handle(new Request(`http://emulator.test${path}`, { method, headers: { 'content-type': 'application/json' }, body }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
};
const events = (e: Engine, type: string) => e.webhooks.events.filter((x) => x.type === type);
const anon = (e: Engine) => client(e, null);

// ── Amazon SNS certificate ──────────────────────────────────────────

/** An engine whose email provider is SES, with one message sent through it. */
async function sesArrange() {
  const e = makeEngine();
  const call = client(e);
  expect((await call('PUT', '/v1/messaging_providers/email', { transport: 'ses', from_address: 'app@example.com', config: { region: 'us-east-1', access_key_id: 'AKIAEXAMPLE', secret_access_key: 'secret' } })).status).toBe(200);
  e.messages.send({ channel: 'email', to: 'ada@example.com', subject: 'hi', meta: { template: 'welcome' } });
  const [row] = (await call('GET', '/v1/messages?recipient=ada%40example.com')).json.data;
  return { e, call, row };
}
const post = (e: Engine, cb: any, body: string = cb.body) => {
  const u = new URL(cb.url);
  return raw(e, 'POST', u.pathname + u.search, body);
};
const signed = async (e: Engine, row: any, event = 'delivered') => (await anon(e)('POST', '/__emulator/messaging/sign', { provider: 'ses', message_id: row.id, event })).json;

describe('Amazon SNS signing certificate', () => {
  it('serves a real self-signed X.509 certificate and its test key', async () => {
    const e = makeEngine();
    const info = (await anon(e)('GET', '/__emulator/messaging/sns')).json;
    expect(info).toMatchObject({ object: 'sns_signing_certificate', signature_versions: ['1', '2'] });
    expect(info.signing_cert_url).toMatch(/^https:\/\/sns\.[a-z0-9-]+\.amazonaws\.com\//);
    const cert = new X509Certificate(info.certificate_pem);
    expect(cert.subject).toContain('sns.us-east-1.amazonaws.com');
    expect(cert.verify(cert.publicKey)).toBe(true);
    // the file the URL serves is that same certificate
    const res = await e.handle(new Request('http://emulator.test/__emulator/messaging/sns/SimpleNotificationService-emulator.pem'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(info.certificate_pem);
    // the signing_keys listing carries it too
    const ses = (await anon(e)('GET', '/__emulator/messaging/signing_keys')).json.data.find((k: any) => k.provider === 'ses');
    expect(ses.certificate_pem).toBe(info.certificate_pem);
  });

  it('accepts a callback signed with the private key of the served certificate (SignatureVersion 1 and 2) and refuses a tampered one', async () => {
    const { e, row } = await sesArrange();
    const info = (await anon(e)('GET', '/__emulator/messaging/sns')).json;
    for (const version of ['1', '2']) {
      const cb = await signed(e, row);
      const m = JSON.parse(cb.body);
      m.SignatureVersion = version;
      const toSign = ['Message', 'MessageId', 'Timestamp', 'TopicArn', 'Type'].map((f) => `${f}\n${m[f]}\n`).join('');
      m.Signature = createSign(version === '2' ? 'RSA-SHA256' : 'RSA-SHA1').update(toSign).sign(info.private_key_pem, 'base64');
      expect((await post(e, cb, JSON.stringify(m))).status).toBe(200);
      expect((await post(e, cb, JSON.stringify({ ...m, Message: `${m.Message} ` }))).status).toBe(401);
    }
    const tampered = (await anon(e)('POST', '/__emulator/messaging/sns/sign', { message: '{}', tamper: true })).json;
    expect((await post(e, tampered)).status).toBe(401);
  });

  it('applies the real SigningCertURL rules: https, an sns.<region>.amazonaws.com host, no credentials or odd port, and a URL that serves a certificate', async () => {
    const { e, row } = await sesArrange();
    const cb = await signed(e, row);
    const m = JSON.parse(cb.body);
    const withUrl = (url: unknown) => post(e, cb, JSON.stringify({ ...m, SigningCertURL: url }));
    expect((await withUrl(m.SigningCertURL)).status).toBe(200);
    expect((await withUrl('http://sns.us-east-1.amazonaws.com/SimpleNotificationService-emulator.pem')).status).toBe(401);
    expect((await withUrl('https://sns.us-east-1.amazonaws.com.evil.example/SimpleNotificationService-emulator.pem')).status).toBe(401);
    expect((await withUrl('https://evil.example/SimpleNotificationService-emulator.pem')).status).toBe(401);
    expect((await withUrl('https://user:pw@sns.us-east-1.amazonaws.com/SimpleNotificationService-emulator.pem')).status).toBe(401);
    expect((await withUrl('https://sns.us-east-1.amazonaws.com:8443/SimpleNotificationService-emulator.pem')).status).toBe(401);
    // a valid SNS host whose path serves no certificate fails like an unreachable one
    expect((await withUrl('https://sns.eu-west-1.amazonaws.com/other.pem')).status).toBe(401);
    expect((await withUrl(undefined)).status).toBe(401);
    expect((await post(e, cb, JSON.stringify({ ...m, SignatureVersion: '3' }))).status).toBe(401);
  });

  it('serves extra certificates a test registers, validates them, and stops serving a removed one', async () => {
    const { e } = await sesArrange();
    const a = anon(e);
    const info = (await a('GET', '/__emulator/messaging/sns')).json;
    const url = 'https://sns.ap-southeast-2.amazonaws.com/SimpleNotificationService-custom.pem';
    const message = JSON.stringify({ notificationType: 'Delivery', mail: { messageId: 'nothing', timestamp: new Date().toISOString() }, delivery: { recipients: ['x@example.com'] } });
    const cb = (await a('POST', '/__emulator/messaging/sns/sign', { message, signing_cert_url: url })).json;
    expect((await post(e, cb)).status).toBe(401);
    expect((await a('PUT', '/__emulator/messaging/sns/certificates', { url: 'https://evil.example/c.pem', certificate_pem: info.certificate_pem })).status).toBe(400);
    expect((await a('PUT', '/__emulator/messaging/sns/certificates', { url, certificate_pem: 'not a certificate' })).status).toBe(400);
    expect((await a('PUT', '/__emulator/messaging/sns/certificates', { url, certificate_pem: info.certificate_pem })).status).toBe(201);
    expect((await a('GET', '/__emulator/messaging/sns')).json.extra_certificates).toEqual([url]);
    expect((await post(e, cb)).status).toBe(200);
    expect((await a('DELETE', `/__emulator/messaging/sns/certificates?url=${encodeURIComponent(url)}`)).json).toMatchObject({ deleted: true });
    expect((await post(e, cb)).status).toBe(401);
    expect((await a('DELETE', `/__emulator/messaging/sns/certificates?url=${encodeURIComponent(url)}`)).status).toBe(404);
  });

  it('records the subscription confirmation URL a verified SubscriptionConfirmation names, and refuses an unsigned one', async () => {
    const { e } = await sesArrange();
    const a = anon(e);
    const cb = (await a('POST', '/__emulator/messaging/sns/sign', { type: 'SubscriptionConfirmation' })).json;
    const r = await post(e, cb);
    expect(r).toMatchObject({ status: 200, json: { received: true, confirmed: true } });
    const info = (await a('GET', '/__emulator/messaging/sns')).json;
    expect(info.subscription_confirmations).toHaveLength(1);
    expect(info.subscription_confirmations[0].subscribe_url).toContain('Action=ConfirmSubscription');
    const forged = JSON.parse(cb.body);
    forged.Signature = 'AAAA';
    expect((await post(e, cb, JSON.stringify(forged))).status).toBe(401);
    expect((await a('POST', '/__emulator/messaging/sns/sign', { type: 'Other' })).status).toBe(400);
    expect((await a('POST', '/__emulator/messaging/sns/sign', { signature_version: '9' })).status).toBe(400);
  });
});

// ── journeys: versions, experiments ─────────────────────────────────

const mkUser = async (call: ReturnType<typeof client>, n: string, extra: Record<string, unknown> = {}) => (await call('POST', '/v1/users', { email_address: `${n}@example.com`, first_name: n[0]!.toUpperCase() + n.slice(1), ...extra })).json.id as string;
const FORM = (id: string) => ({ id, type: 'form', fields: [{ key: 'name', label: 'Name', type: 'text' }] });
async function mkFlow(call: ReturnType<typeof client>, v1: unknown = { steps: [FORM('ask')] }, v2: unknown = { steps: [FORM('ask2')] }) {
  const flow = (await call('POST', '/v1/flows', { name: `j-${Math.random().toString(36).slice(2)}`, definition: v1 })).json;
  if (v2) expect((await call('PATCH', `/v1/flows/${flow.id}`, { definition: v2, activate: false })).status).toBe(200);
  return flow.id as string;
}
const VARIANTS = [
  { key: 'control', version: 1, weight: 50 },
  { key: 'short', version: 2, weight: 50 },
];
const bucketOf = (experimentId: string, userId: string) => createHash('sha256').update(`${experimentId}\u0000${userId}`).digest().readUInt32BE(0) % 100;
const start = async (call: ReturnType<typeof client>, e: Engine, flowId: string, userId: string, stage = 'sign_in') => (await anon(e)('POST', `/__emulator/journeys/${flowId}/start`, { user_id: userId, stage })).json;

describe('journey versions', () => {
  it('keeps every saved version, activates one on request and refuses unknown versions', async () => {
    const e = makeEngine();
    const call = client(e);
    const id = await mkFlow(call);
    const flow = (await call('GET', `/v1/flows/${id}`)).json;
    expect(flow).toMatchObject({ active_version: 1, latest_version: 2 });
    expect(flow.definition.steps[0].id).toBe('ask');
    const versions = (await call('GET', `/v1/flows/${id}/versions`)).json.data;
    expect(versions.map((v: any) => v.version)).toEqual([2, 1]);
    expect(versions[0]).toMatchObject({ object: 'sign_in_journey_version' });
    expect((await call('POST', `/v1/flows/${id}/activate`, { version: 99 })).status).toBe(404);
    expect((await call('POST', `/v1/flows/${id}/activate`, { version: 'two' })).status).toBe(400);
    const activated = (await call('POST', `/v1/flows/${id}/activate`, { version: 2 })).json;
    expect(activated).toMatchObject({ active_version: 2 });
    expect(activated.definition.steps[0].id).toBe('ask2');
    // a new version made with activate unset becomes the active one
    expect((await call('PATCH', `/v1/flows/${id}`, { definition: { steps: [FORM('ask3')] } })).json).toMatchObject({ active_version: 3, latest_version: 3 });
  });
});

describe('journey experiments', () => {
  it('validates variants like the API', async () => {
    const e = makeEngine();
    const call = client(e);
    const id = await mkFlow(call);
    const post = (body: unknown) => call('POST', `/v1/flows/${id}/experiments`, body);
    expect((await post({ name: 'x', variants: [{ key: 'a', version: 1, weight: 100 }] })).status).toBe(400);
    expect((await post({ name: 'x', variants: [{ key: 'a', version: 1, weight: 60 }, { key: 'b', version: 2, weight: 60 }] })).json.errors[0].message).toContain('add up to 100');
    expect((await post({ name: 'x', variants: [{ key: 'a', version: 1, weight: 50 }, { key: 'b', version: 7, weight: 50 }] })).json.errors[0].param).toBe('variants.1.version');
    expect((await post({ name: 'x', variants: [{ key: 'A b', version: 1, weight: 50 }, { key: 'b', version: 2, weight: 50 }] })).json.errors[0].param).toBe('variants.0.key');
    expect((await post({ name: 'x', variants: [{ key: 'a', version: 1, weight: 50 }, { key: 'a', version: 2, weight: 50 }] })).status).toBe(400);
    expect((await post({ variants: VARIANTS })).json.errors[0].param).toBe('name');
    expect((await post({ name: 'x', variants: VARIANTS, colour: 'blue' })).json.errors[0].param).toBe('colour');
    expect((await call('POST', '/v1/flows/flow_nope/experiments', { name: 'x', variants: VARIANTS })).status).toBe(404);
    const made = await post({ name: 'x', hypothesis: 'h', variants: VARIANTS });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ object: 'journey_experiment', journey_id: id, name: 'x', status: 'draft', hypothesis: 'h', promoted_variant: null, started_at: null });
    expect((await post({ name: 'x', variants: VARIANTS })).json.errors[0].message).toContain('already exists');
    // a draft can be edited; unknown experiment ids 404
    expect((await call('PATCH', `/v1/flows/${id}/experiments/${made.json.id}`, { hypothesis: 'new' })).json.hypothesis).toBe('new');
    expect((await call('GET', `/v1/flows/${id}/experiments/jexp_nope`)).status).toBe(404);
    const other = await mkFlow(call);
    expect((await call('GET', `/v1/flows/${other}/experiments/${made.json.id}`)).status).toBe(404);
    expect((await call('GET', `/v1/flows/${id}/experiments`)).json.data).toHaveLength(1);
  });

  it('runs one experiment at a time, freezes it once started and emits the events', async () => {
    const e = makeEngine();
    const call = client(e);
    const id = await mkFlow(call);
    const mk = async (name: string) => (await call('POST', `/v1/flows/${id}/experiments`, { name, variants: VARIANTS })).json.id as string;
    const [a, b] = [await mk('a'), await mk('b')];
    const disabled = await mkFlow(call);
    expect((await call('PATCH', `/v1/flows/${disabled}`, { enabled: false })).status).toBe(200);
    const dx = (await call('POST', `/v1/flows/${disabled}/experiments`, { name: 'd', variants: VARIANTS })).json.id;
    expect((await call('POST', `/v1/flows/${disabled}/experiments/${dx}/start`)).status).toBe(409);
    expect((await call('POST', `/v1/flows/${id}/experiments/${a}/start`)).json).toMatchObject({ status: 'running' });
    expect(events(e, 'journey.experiment_started')).toHaveLength(1);
    expect(events(e, 'journey.experiment_started')[0]!.payload.data).toMatchObject({ experiment_id: a, journey_id: id });
    expect((await call('POST', `/v1/flows/${id}/experiments/${a}/start`)).status).toBe(409);
    expect((await call('POST', `/v1/flows/${id}/experiments/${b}/start`)).status).toBe(409);
    expect((await call('PATCH', `/v1/flows/${id}/experiments/${a}`, { name: 'renamed' })).status).toBe(409);
    expect((await call('DELETE', `/v1/flows/${id}/experiments/${a}`)).status).toBe(409);
    expect((await call('POST', `/v1/flows/${id}/experiments/${b}/stop`, {})).status).toBe(409);
    expect((await call('POST', `/v1/flows/${id}/experiments/${a}/stop`, { promote_variant: 'nope' })).json.errors[0].param).toBe('promote_variant');
    const stopped = (await call('POST', `/v1/flows/${id}/experiments/${a}/stop`, { promote_variant: 'short' })).json;
    expect(stopped).toMatchObject({ status: 'stopped', promoted_variant: 'short' });
    expect(events(e, 'journey.experiment_stopped')[0]!.payload.data).toMatchObject({ experiment_id: a, promoted_variant: 'short' });
    // promotion made version 2 the active one
    expect((await call('GET', `/v1/flows/${id}`)).json).toMatchObject({ active_version: 2 });
    expect((await call('POST', `/v1/flows/${id}/experiments/${a}/stop`, {})).status).toBe(409);
    expect((await call('POST', `/v1/flows/${id}/experiments/${b}/start`)).status).toBe(200);
    expect((await call('DELETE', `/v1/flows/${id}/experiments/${a}`)).json).toMatchObject({ deleted: true });
    const trail = (await anon(e)('GET', '/__emulator/messaging/audit')).json.data.map((x: any) => x.action);
    expect(trail).toEqual(expect.arrayContaining(['journey_experiment.created', 'journey_experiment.started', 'journey_experiment.stopped', 'journey_experiment.deleted']));
  });

  it('assigns users deterministically by hash, stickily, and each variant runs its own version', async () => {
    const e = makeEngine();
    const call = client(e);
    const id = await mkFlow(call);
    const x = (await call('POST', `/v1/flows/${id}/experiments`, { name: 'split', variants: [{ key: 'control', version: 1, weight: 30 }, { key: 'short', version: 2, weight: 70 }] })).json.id;
    // a user who arrives before the experiment runs is not assigned
    const early = await mkUser(call, 'early');
    expect((await start(call, e, id, early)).open_steps).toEqual(['ask']);
    expect((await call('POST', `/v1/flows/${id}/experiments/${x}/start`)).status).toBe(200);
    const seen: Record<string, number> = { control: 0, short: 0 };
    for (let i = 0; i < 40; i++) {
      const u = await mkUser(call, `u${i}`);
      const expected = bucketOf(x, u) < 30 ? 'control' : 'short';
      const probe = (await anon(e)('GET', `/__emulator/journeys/${id}/experiments/${x}/bucket?user_id=${u}`)).json;
      expect(probe).toMatchObject({ bucket: bucketOf(x, u), variant: expected, assigned: null });
      const run = await start(call, e, id, u);
      expect(run.open_steps).toEqual([expected === 'control' ? 'ask' : 'ask2']);
      seen[expected]!++;
      // sticky: the same user reaching the journey again keeps the variant, and a probe now shows it as assigned
      expect((await start(call, e, id, u)).id).toBe(run.id);
      expect((await anon(e)('GET', `/__emulator/journeys/${id}/experiments/${x}/bucket?user_id=${u}`)).json.assigned).toBe(expected);
    }
    expect(seen.control).toBeGreaterThan(0);
    expect(seen.short).toBeGreaterThan(0);
    expect((await anon(e)('GET', `/__emulator/journeys/${id}/experiments/${x}/bucket`)).status).toBe(400);
    const readout = (await call('GET', `/v1/flows/${id}/experiments/${x}/readout`)).json;
    expect(readout.variants.map((v: any) => [v.key, v.assigned])).toEqual([['control', seen.control], ['short', seen.short]]);
  });

  it('reads out completion per variant with rates, an interval, lift and significance against the control', async () => {
    const e = makeEngine();
    const call = client(e);
    const id = await mkFlow(call);
    const x = (await call('POST', `/v1/flows/${id}/experiments`, { name: 'readout', variants: VARIANTS })).json.id;
    await call('POST', `/v1/flows/${id}/experiments/${x}/start`);
    const byVariant: Record<string, string[]> = { control: [], short: [] };
    for (let i = 0; byVariant.control!.length < 40 || byVariant.short!.length < 40; i++) {
      const u = await mkUser(call, `r${i}`);
      const v = bucketOf(x, u) < 50 ? 'control' : 'short';
      if (byVariant[v]!.length >= 40) continue;
      byVariant[v]!.push(u);
    }
    for (const [v, users] of Object.entries(byVariant)) {
      const finishing = v === 'control' ? 10 : 36; // 25% against 90% completion
      for (const [i, u] of users.entries()) {
        const run = await start(call, e, id, u);
        if (i < finishing) await anon(e)('POST', `/__emulator/journeys/runs/${run.id}/complete_step`, { step: run.open_steps[0] });
      }
    }
    e.clock.advance(5000);
    const out = (await call('GET', `/v1/flows/${id}/experiments/${x}/readout`)).json;
    expect(out).toMatchObject({ object: 'journey_experiment_readout', metric: 'completion', control: 'control', significance_level: 0.05 });
    const [c, s] = out.variants;
    expect(c).toMatchObject({ key: 'control', assigned: 40, started: 40, completed: 10, in_progress: 30, completion_rate: 0.25, lift: null, p_value: null, significant: false });
    expect(s).toMatchObject({ key: 'short', started: 40, completed: 36, completion_rate: 0.9, significant: true });
    expect(s.lift).toBeCloseTo((0.9 - 0.25) / 0.25, 6);
    expect(s.p_value).toBeLessThan(0.001);
    expect(c.completion_interval[0]).toBeLessThan(0.25);
    expect(c.completion_interval[1]).toBeGreaterThan(0.25);
  });
});

// ── scheduled messages ──────────────────────────────────────────────

const MAIL_FLOW = {
  steps: [FORM('ask'), { id: 'welcome', type: 'send_message', subject: 'Welcome {{first_name}}', body: 'Hello {{first_name}} ({{email}})', sms_body: 'Hi {{first_name}}' }, { id: 'wait', type: 'delay', delay_seconds: 3600 }, { id: 'later', type: 'send_message', subject: 'Checking in', body: 'How is it going?' }],
};
async function finish(call: ReturnType<typeof client>, e: Engine, flowId: string, userId: string) {
  const run = await start(call, e, flowId, userId);
  // automatic steps never hold the user: only the form is open
  expect(run.open_steps).toEqual(['ask']);
  await anon(e)('POST', `/__emulator/journeys/runs/${run.id}/complete_step`, { step: 'ask' });
  return run;
}
const sunk = (e: Engine, channel: string) => e.messages.list({ channel }).filter((m) => m.meta?.template === 'journey_message');

describe('scheduled journey messages', () => {
  it('schedules a completed journey\'s messages, sends them through the sink at their time, and keeps one row per step ever', async () => {
    const e = makeEngine();
    const call = client(e);
    const id = await mkFlow(call, MAIL_FLOW, null as any);
    const u = await mkUser(call, 'mia', { last_name: 'Ray' });
    expect((await anon(e)('PUT', `/__emulator/users/${u}/phone_number`, { phone_number: '+4915112345678' })).status).toBe(200);
    const run = await start(call, e, id, u);
    // nothing is scheduled while the journey is still open
    expect((await call('GET', `/v1/flows/${id}/messages`)).json.data).toEqual([]);
    await anon(e)('POST', `/__emulator/journeys/runs/${run.id}/complete_step`, { step: 'ask' });
    const all = (await call('GET', `/v1/flows/${id}/messages?user_id=${u}`)).json.data;
    // the first message has no delay and is due at once; the sms of the same step is its own row
    expect(all.map((m: any) => `${m.step}/${m.channel}/${m.status}`).sort()).toEqual(['later/email/pending', 'welcome/email/sent', 'welcome/sms/sent']);
    expect(all[0]).toMatchObject({ object: 'journey_message', journey_id: id, user_id: u });
    expect(JSON.stringify(all)).not.toContain('Hello');
    const mail = sunk(e, 'email');
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ to: 'mia@example.com', subject: 'Welcome Mia', body: 'Hello Mia (mia@example.com)' });
    expect(sunk(e, 'sms')[0]).toMatchObject({ to: '+4915112345678', body: 'Hi Mia' });
    expect(events(e, 'journey.message_sent').map((x) => x.payload.data.step)).toEqual(['welcome', 'welcome']);
    expect(events(e, 'journey.message_sent')[0]!.payload.data).not.toHaveProperty('to');
    // the delayed one waits for the clock
    const later = all.find((m: any) => m.step === 'later');
    expect(later.send_at - e.clock.now()).toBeGreaterThan(3_590_000);
    expect(later.send_at - e.clock.now()).toBeLessThanOrEqual(3_600_000);
    await anon(e)('POST', '/__emulator/time/advance', { ms: 3599_000 });
    expect(sunk(e, 'email')).toHaveLength(1);
    await anon(e)('POST', '/__emulator/time/advance', { ms: 1000 });
    expect(sunk(e, 'email').map((m) => m.subject)).toEqual(['Welcome Mia', 'Checking in']);
    expect((await call('GET', `/v1/flows/${id}/messages?status=sent`)).json.data).toHaveLength(3);
    // completing the journey again schedules nothing new
    await finish(call, e, id, u);
    expect((await call('GET', `/v1/flows/${id}/messages`)).json.data).toHaveLength(3);
    // the delivery sweep is idempotent
    expect((await anon(e)('POST', '/__emulator/journeys/messages/deliver')).json).toMatchObject({ sent: 0, retried: 0, failed: 0 });
  });

  it('cancels a pending message and refuses to cancel one that has gone out', async () => {
    const e = makeEngine();
    const call = client(e);
    const id = await mkFlow(call, MAIL_FLOW, null as any);
    const u = await mkUser(call, 'cal');
    await finish(call, e, id, u);
    const rows = (await call('GET', `/v1/flows/${id}/messages`)).json.data;
    const pending = rows.find((m: any) => m.status === 'pending');
    const sent = rows.find((m: any) => m.status === 'sent');
    expect(sent).toBeTruthy();
    expect((await call('POST', `/v1/flows/${id}/messages/${sent.id}/cancel`)).status).toBe(409);
    expect((await call('POST', `/v1/flows/${id}/messages/jmsg_nope/cancel`)).status).toBe(404);
    expect((await call('POST', `/v1/flows/${id}/messages/${pending.id}/cancel`)).json).toMatchObject({ status: 'canceled' });
    expect((await call('POST', `/v1/flows/${id}/messages/${pending.id}/cancel`)).status).toBe(409);
    await anon(e)('POST', '/__emulator/time/advance', { ms: 7200_000 });
    expect(sunk(e, 'email').map((m) => m.subject)).toEqual(['Welcome Cal']);
    expect((await call('GET', `/v1/flows/${id}/messages?status=canceled`)).json.data).toHaveLength(1);
    expect((await call('GET', `/v1/flows/${id}/messages?status=nope`)).status).toBe(400);
    expect((await anon(e)('GET', '/__emulator/messaging/audit')).json.data.map((a: any) => a.action)).toContain('journey_message.canceled');
  });

  it('closes a message as failed, with an event, when the user cannot be reached', async () => {
    const e = makeEngine();
    const call = client(e);
    const id = await mkFlow(call, MAIL_FLOW, null as any);
    // no verified phone number: the text fails for good, the email still goes
    const noPhone = await mkUser(call, 'nophone');
    await finish(call, e, id, noPhone);
    const rows = (await call('GET', `/v1/flows/${id}/messages?user_id=${noPhone}`)).json.data;
    const sms = rows.find((m: any) => m.channel === 'sms');
    expect(sms).toMatchObject({ status: 'failed', last_error: 'The user has no verified phone number.', attempts: 1 });
    expect(events(e, 'journey.message_failed')[0]!.payload.data).toMatchObject({ journey_id: id, user_id: noPhone, step: 'welcome', channel: 'sms', reason: 'The user has no verified phone number.' });
    // an unverified email: the user gets no mail
    const unverified = await mkUser(call, 'unverified', { email_verified: false });
    await finish(call, e, id, unverified);
    expect((await call('GET', `/v1/flows/${id}/messages?user_id=${unverified}&status=failed`)).json.data.find((m: any) => m.channel === 'email').last_error).toBe('The user has no verified email address.');
    // banned between the completion and the send time: nothing is sent
    const banned = await mkUser(call, 'banned');
    await finish(call, e, id, banned);
    await call('POST', `/v1/users/${banned}/ban`);
    await anon(e)('POST', '/__emulator/time/advance', { ms: 3600_000 });
    expect(sunk(e, 'email').filter((m) => m.to === 'banned@example.com')).toHaveLength(0);
    expect((await call('GET', `/v1/flows/${id}/messages?user_id=${banned}&status=failed`)).json.data[0].last_error).toBe('The user was deleted or banned.');
  });

  it('schedules messages for a user without finishing a journey, and validates the request', async () => {
    const e = makeEngine();
    const call = client(e);
    const id = await mkFlow(call, MAIL_FLOW, null as any);
    const u = await mkUser(call, 'sam');
    const a = anon(e);
    expect((await a('POST', `/__emulator/journeys/${id}/messages`, { user_id: u, messages: [{ step: 'tip', subject: 'A tip', body: 'Try this', delay_seconds: 60 }] })).json).toMatchObject({ scheduled: 1 });
    expect((await a('POST', `/__emulator/journeys/${id}/messages`, { user_id: u, messages: [{ step: 'tip', subject: 'A tip', body: 'Try this', delay_seconds: 60 }] })).json).toMatchObject({ scheduled: 0 });
    expect((await a('POST', `/__emulator/journeys/${id}/messages`, { user_id: 'user_nope', messages: [] })).status).toBe(404);
    expect((await a('POST', `/__emulator/journeys/${id}/messages`, { user_id: u, messages: [] })).status).toBe(400);
    expect((await a('POST', `/__emulator/journeys/${id}/messages`, { user_id: u, messages: [{ step: 'x', subject: '', body: 'b' }] })).json.errors[0].param).toBe('messages.0.subject');
    expect((await a('POST', `/__emulator/journeys/${id}/messages`, { user_id: u, messages: [{ step: 'x', subject: 's', body: 'b', delay_seconds: -1 }] })).status).toBe(400);
    expect((await a('PUT', `/__emulator/users/${u}/phone_number`, { phone_number: '0123' })).status).toBe(400);
    await a('POST', '/__emulator/time/advance', { ms: 60_000 });
    expect(sunk(e, 'email').map((m) => m.subject)).toEqual(['A tip']);
    expect((await call('GET', '/v1/flows/flow_nope/messages')).status).toBe(404);
  });
});

// ── custom blocks in page templates ─────────────────────────────────

describe('custom page template blocks', () => {
  const put = (call: ReturnType<typeof client>, footer: unknown[], page = 'sign-in') => call('PUT', `/v1/instance/page_templates/${page}`, { definition: { version: 1, regions: { footer } } });

  it('refuses markup and CSS outside the allowlist, naming the first problems', async () => {
    const call = client(makeEngine());
    const script = await put(call, [{ type: 'custom', html: '<script>alert(1)</script><p>x</p>', height: 120 }]);
    expect(script.status).toBe(400);
    expect(script.json.errors[0]).toMatchObject({ param: 'definition.regions.footer[0].html' });
    expect(script.json.errors[0].message).toContain('<script> is not allowed.');
    expect((await put(call, [{ type: 'custom', html: '<p onclick="x()">hi</p>', height: 120 }])).json.errors[0].message).toContain('onclick');
    expect((await put(call, [{ type: 'custom', html: '<a href="javascript:alert(1)">x</a>', height: 120 }])).json.errors[0].message).toContain('https only');
    expect((await put(call, [{ type: 'custom', html: '<img src="http://x.example/a.png" alt="">', height: 120 }])).status).toBe(400);
    expect((await put(call, [{ type: 'custom', html: '<p style="color:red">x</p>', height: 120 }])).json.errors[0].message).toContain('style');
    expect((await put(call, [{ type: 'custom', html: '<p>{{secret}}</p>', height: 120 }])).json.errors[0].message).toContain('{{secret}} is not a variable');
    const css = (value: string) => put(call, [{ type: 'custom', html: '<p>x</p>', css: value, height: 120 }]);
    expect((await css('.a{background:url(https://x.example/a.png)}')).json.errors[0]).toMatchObject({ param: 'definition.regions.footer[0].css' });
    expect((await css('@import "x.css";')).status).toBe(400);
    expect((await css('.a{position:fixed}')).json.errors[0].message).toContain('position');
    expect((await css('#id{color:red}')).status).toBe(400);
    expect((await css('.a{color:red!important}')).status).toBe(400);
    expect((await css('.a{width:var(--x)}')).status).toBe(400);
  });

  it('refuses a missing height, an empty block, a second block in a region and a block inside columns', async () => {
    const call = client(makeEngine());
    expect((await put(call, [{ type: 'custom', html: '<p>x</p>' }])).json.errors[0].param).toBe('definition.regions.footer[0].height');
    expect((await put(call, [{ type: 'custom', html: '<p>x</p>', height: 5 }])).status).toBe(400);
    expect((await put(call, [{ type: 'custom', html: '   ', height: 100 }])).status).toBe(400);
    expect((await put(call, [{ type: 'custom', html: '<p>a</p>', height: 100 }, { type: 'custom', html: '<p>b</p>', height: 100 }])).json.errors[0].message).toContain('at most one custom block');
    const cols = await put(call, [{ type: 'columns', columns: [[{ type: 'custom', html: '<p>a</p>', height: 100 }], []] }]);
    expect(cols.status).toBe(400);
    expect(cols.json.errors[0].message).toContain('cannot sit inside columns');
  });

  it('stores a clean block in its sanitized form: links get safe attributes, variables stay for render time', async () => {
    const call = client(makeEngine());
    const saved = await put(call, [{ type: 'heading', text: 'Hi' }, { type: 'custom', title: 'Notice', html: '<p class="note">Copyright {{year}} &amp; <a href="https://example.com/terms" target="_self">terms</a><br></p>', css: '.note{color:#333;margin:0} @media (max-width: 600px){.note{font-size:12px}}', height: 120 }]);
    expect(saved.status).toBe(200);
    const [, block] = saved.json.draft.regions.footer;
    expect(block).toEqual({ type: 'custom', html: '<p class="note">Copyright {{year}} &amp; <a href="https://example.com/terms" target="_blank" rel="noopener noreferrer">terms</a><br></p>', css: '.note{color:#333;margin:0}@media (max-width: 600px){.note{font-size:12px}}', height: 120, title: 'Notice' });
    expect((await call('GET', '/v1/instance/page_templates/sign-in')).json.draft.regions.footer[1]).toEqual(block);
  });
});
