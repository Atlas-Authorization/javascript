import { describe, expect, it } from 'vitest';
import { createTestEvent, runAction, runScript } from './harness';
import { defineAction, type PostLoginApi, type PostLoginEvent } from './types';

describe('createTestEvent', () => {
  it('populates a post_login event with a real user id', () => {
    const event = createTestEvent('post_login');
    expect(event.user.id).toBe('user_sample');
    expect(event.user.email).toBe('sample@example.com');
    expect(event.connection.strategy).toBe('password');
    expect(event.request.ip).toBeTruthy();
    expect(event.secrets).toEqual({});
  });

  it('gives pre_user_registration a null user id (no row yet)', () => {
    const event = createTestEvent('pre_user_registration');
    expect(event.user.id).toBeNull();
  });

  it('merges overrides one level deep without dropping defaults', () => {
    const event = createTestEvent('post_login', {
      user: { email: 'ada@acme.com', metadata: { roles: ['admin'] } },
      secrets: { CLAIM_NAMESPACE: 'https://acme.test' },
    });
    expect(event.user.email).toBe('ada@acme.com');
    expect(event.user.metadata).toEqual({ roles: ['admin'] });
    // Untouched defaults survive the merge.
    expect(event.user.emailVerified).toBe(true);
    expect(event.connection.strategy).toBe('password');
    expect(event.secrets.CLAIM_NAMESPACE).toBe('https://acme.test');
  });
});

describe('runAction — captures api calls', () => {
  it('captures access.deny with its reason', async () => {
    const action = defineAction('post_login', async (event, api) => {
      if (!event.user.emailVerified) api.access.deny('Verify your email first.');
    });
    const result = await runAction(action, createTestEvent('post_login', { user: { emailVerified: false } }));
    expect(result.denied).toBe(true);
    expect(result.denyReason).toBe('Verify your email first.');
    expect(result.calls).toContainEqual({ method: 'access.deny', args: ['Verify your email first.'] });
  });

  it('defaults the deny reason when none is given', async () => {
    const result = await runAction(
      defineAction('post_login', (_event, api) => api.access.deny()),
      createTestEvent('post_login'),
    );
    expect(result.denied).toBe(true);
    expect(result.denyReason).toBe('Access denied.');
  });

  it('captures setCustomClaim on both token buckets and setAppMetadata', async () => {
    const action = defineAction('post_login', (_event, api) => {
      api.idToken.setCustomClaim('role', 'admin');
      api.accessToken.setCustomClaim('role', 'admin');
      api.user.setAppMetadata('onboarded', true);
      api.console.log('done', { ok: 1 });
    });
    const result = await runAction(action, createTestEvent('post_login'));
    expect(result.idTokenClaims).toEqual({ role: 'admin' });
    expect(result.accessTokenClaims).toEqual({ role: 'admin' });
    expect(result.appMetadata).toEqual({ onboarded: true });
    expect(result.logs).toEqual(['done {"ok":1}']);
    expect(result.denied).toBe(false);
  });

  it('captures api.session.setCustomData on post_login', async () => {
    const action = defineAction('post_login', (_event, api) => {
      api.session.setCustomData('cart_id', 'c_1');
      api.session.setCustomData('k'.repeat(80), 1);
    });
    const result = await runAction(action, createTestEvent('post_login'));
    expect(result.sessionData).toEqual({ cart_id: 'c_1', ['k'.repeat(64)]: 1 });
    expect(result.calls[0]).toEqual({ method: 'session.setCustomData', args: ['cart_id', 'c_1'] });
  });

  it('accepts a bare handler as well as a DefinedAction', async () => {
    // A bare handler (not a DefinedAction), with explicit param types.
    const result = await runAction(
      (_event: PostLoginEvent, api: PostLoginApi) => api.idToken.setCustomClaim('x', 1),
      createTestEvent('post_login'),
    );
    expect(result.idTokenClaims).toEqual({ x: 1 });
  });

  it('captures a thrown error instead of propagating it', async () => {
    const result = await runAction(
      () => {
        throw new Error('boom');
      },
      createTestEvent('post_login'),
    );
    expect(result.error).toBe('boom');
    expect(result.denied).toBe(false);
  });

  it('truncates a claim key to 256 chars, matching the isolate', async () => {
    const long = 'k'.repeat(300);
    const result = await runAction(
      defineAction('post_login', (_e, api) => api.idToken.setCustomClaim(long, 1)),
      createTestEvent('post_login'),
    );
    expect(Object.keys(result.idTokenClaims)[0]!.length).toBe(256);
  });
});

describe('runScript — the deployable code body', () => {
  it('runs a raw script that denies', async () => {
    const result = await runScript(
      `if (!event.user.emailVerified) { api.access.deny('nope'); }`,
      createTestEvent('post_login', { user: { emailVerified: false } }),
    );
    expect(result.denied).toBe(true);
    expect(result.denyReason).toBe('nope');
  });

  it('a defineAction.toCode() round-trips to the same result as the handler', async () => {
    const action = defineAction('post_login', async (_event, api) => {
      api.idToken.setCustomClaim('via', 'code');
    });
    const viaHandler = await runAction(action, createTestEvent('post_login'));
    const viaCode = await runScript(action.toCode(), createTestEvent('post_login'));
    expect(viaCode.idTokenClaims).toEqual(viaHandler.idTokenClaims);
  });

  it('a script using a forbidden host global (bare console) fails, as it would in the isolate', async () => {
    // The isolate has no bare `console` (logging is `api.console.log`); the
    // harness shadows it to undefined, so using it throws and is captured.
    const result = await runScript(`console.log('hi')`, createTestEvent('post_login'));
    expect(result.error).toBeTruthy();
    expect(result.logs).toEqual([]); // nothing reached the real stdout
  });
});

describe('api.http in the harness', () => {
  it('queues requests exactly as the platform would send them', async () => {
    const action = defineAction('post_login', async (event, api) => {
      api.http.post('https://hooks.example/atlas', { email: event.user.email }, { headers: { 'X-Token': event.secrets.TOKEN ?? '' } });
      api.http.get('https://lookup.example/p', { saveResponseAs: 'profile' });
    });
    const result = await runAction(action, createTestEvent('post_login', { secrets: { TOKEN: 't' } }));
    expect(result.error).toBeNull();
    expect(result.httpRequests).toEqual([
      {
        method: 'POST',
        url: 'https://hooks.example/atlas',
        headers: { 'X-Token': 't', 'content-type': 'application/json' },
        body: '{"email":"sample@example.com"}',
        saveResponseAs: null,
      },
      { method: 'GET', url: 'https://lookup.example/p', headers: {}, body: null, saveResponseAs: 'profile' },
    ]);
  });

  it('throws on what the sandbox refuses (http URLs, forbidden headers, too many)', async () => {
    const plain = await runScript(`api.http.get('http://x.example/')`, createTestEvent('post_login'));
    expect(plain.error).toMatch(/https:\/\//);
    const host = await runScript(`api.http.post('https://x.example/', 'b', { headers: { host: 'y' } })`, createTestEvent('post_login'));
    expect(host.error).toMatch(/set by Atlas/);
    const many = await runScript(`for (let i = 0; i < 6; i++) api.http.get('https://x.example/' + i)`, createTestEvent('post_login'));
    expect(many.error).toMatch(/at most 5/);
  });

  it('queues service-connector calls and refuses malformed ones', async () => {
    const ok = await runScript(`api.connector.send('sms', 'send_sms', { to: '+15550001', body: 'hi' })`, createTestEvent('post_login'));
    expect(ok.error).toBeNull();
    expect(ok.connectorCalls).toEqual([{ name: 'sms', operation: 'send_sms', input: { to: '+15550001', body: 'hi' } }]);
    const bad = await runScript(`api.connector.send('Bad Name', 'send_sms')`, createTestEvent('post_login'));
    expect(bad.error).toMatch(/connector name/);
    const many = await runScript(`for (let i = 0; i < 6; i++) api.connector.send('sms', 'send_sms')`, createTestEvent('post_login'));
    expect(many.error).toMatch(/at most 5/);
  });

  it('the test event carries organizations and a country', () => {
    const event = createTestEvent('post_login', {
      user: { organizations: [{ id: 'org_1', slug: 'acme', name: 'Acme', role: 'org:admin' }] },
      request: { country: 'DE' },
    });
    expect(event.user.organizations[0]!.role).toBe('org:admin');
    expect(event.request.country).toBe('DE');
    expect(createTestEvent('post_login').user.organizations).toEqual([]);
  });
});

describe('EXT-01 api surface in the harness', () => {
  it('captures lock, suppressClaim, user edits and sign-up shaping', async () => {
    const result = await runScript(
      `
        api.access.lock('slow down');
        api.accessToken.suppressClaim('email');
        api.idToken.suppressClaim('name');
        api.user.setBanned(true, 'fraud');
        api.user.setEmailVerified(true);
        api.user.setName('Ada');
        api.signUp.prefill('company', 'Acme');
        api.signUp.modify('country', 'DE');
      `,
      createTestEvent('pre_user_registration'),
    );
    expect(result.error).toBeNull();
    expect(result.lockReason).toBe('slow down');
    expect(result.suppressedAccessClaims).toEqual(['email']);
    expect(result.suppressedIdClaims).toEqual(['name']);
    expect(result.userEdits).toEqual({ banned: { value: true, reason: 'fraud' }, emailVerified: true, firstName: 'Ada' });
    expect(result.signUpPrefill).toEqual({ company: 'Acme' });
    expect(result.signUpModify).toEqual({ country: 'DE' });
  });

  it('builds a test event with context, sign-up fields and an organization', () => {
    const event = createTestEvent('pre_member_add', { context: { x: 1 }, organization: { id: 'org_1', name: 'Acme', slug: 'acme' } });
    expect(event.context).toEqual({ trigger: 'pre_member_add', x: 1 });
    expect(event.organization.slug).toBe('acme');
  });
});

describe('EXT-04 challenge api in the harness', () => {
  it('captures the prompt and the accept verdict', async () => {
    const created = await runScript(`api.challenge.set({ prompt: 'Q?', state: { a: 1 } });`, createTestEvent('custom_challenge_create'));
    expect(created.challenge).toEqual({ prompt: 'Q?', hint: null, state: { a: 1 } });
    const verified = await runScript(`api.challenge.accept({ amr: ['kba'] });`, createTestEvent('custom_challenge_verify'));
    expect(verified.challengeAccept).toEqual({ amr: ['kba'] });
  });
});
