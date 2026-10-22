// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptsReferral,
  captureReferral,
  configureReferralCapture,
  parseReferralCookie,
  referralChallengeRequired,
  lookupReferralCode,
  referralParams,
  signIn,
  signUp,
  withReferralParams,
  referralCodeFromSearch,
  referralConfigFrom,
  referralConsentGranted,
  referralSearches,
  resetReferralCapture,
  type ReferralConfig,
} from './referral';
import { FapiClient } from './fapi';
import { fetchInstanceSettings, referralChallengeFlows } from './instance-settings';

const win = window as unknown as Record<string, unknown>;

const ON: ReferralConfig = {
  enabled: true,
  urlParams: ['ref', 'via'],
  contextCookie: 'acme_ref',
  consentCategory: 'referrals',
  consentFallbackCategory: 'marketing',
  challengeReferredSignups: 'inherit',
  codeLookupUrl: null,
  signupCodeField: false,
};

const ENV = {
  object: 'environment',
  referrals: {
    enabled: true,
    url_params: ['ref', 'via'],
    context_cookie: 'acme_ref',
    consent_category: 'referrals',
    consent_fallback_category: 'marketing',
    challenge_referred_signups: 'inherit',
  },
};

interface Sent {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

/** A FAPI client whose fetch answers the environment / appearance reads and records every call. */
function client(env: unknown = ENV, appearance: unknown = { captchaFlows: {} }, options: Record<string, unknown> = {}) {
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    sent.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null });
    const body = url.endsWith('/v1/client/environment') ? env : url.endsWith('/v1/appearance') ? appearance : { id: 'sia_1', status: 'needs_first_factor' };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { sent, client: new FapiClient({ publishableKey: 'pk_test_1', baseUrl: 'https://fapi.example.com', fetchImpl, ...options }) };
}

const setUrl = (path: string) => window.history.replaceState({}, '', path);
const clearCookie = () => {
  document.cookie = 'acme_ref=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
};

beforeEach(() => {
  resetReferralCapture();
  setUrl('/');
  clearCookie();
  delete win.CookieMunch;
  delete win.aff;
});
afterEach(() => {
  resetReferralCapture();
  delete win.CookieMunch;
  delete win.aff;
});

describe('referral config + pure capture', () => {
  it('reads the public config; off or missing → disabled', () => {
    expect(referralConfigFrom(ENV)).toEqual(ON);
    expect(referralConfigFrom({ referrals: { ...ENV.referrals, challenge_referred_signups: 'always' } }).challengeReferredSignups).toBe('always');
    expect(referralConfigFrom({}).enabled).toBe(false);
    expect(referralConfigFrom({ referrals: { enabled: false } }).enabled).toBe(false);
    expect(referralConfigFrom({ referrals: { enabled: true, url_params: [], context_cookie: 'bad cookie' } })).toMatchObject({
      urlParams: ['ref', 'via', 'aff'],
      contextCookie: null,
    });
  });

  it('takes the first well-formed code among the params, in order', () => {
    expect(referralCodeFromSearch('?via=B22&ref=A11', ['ref', 'via'])).toBe('A11');
    expect(referralCodeFromSearch('?ref=x&via=B22', ['ref', 'via'])).toBe('B22');
    expect(referralCodeFromSearch('?aff=C33', ['ref', 'via'])).toBeNull();
    expect(referralCodeFromSearch('', ['ref'])).toBeNull();
  });

  it('looks inside redirect_url / after_url', () => {
    const searches = referralSearches([`?redirect_url=${encodeURIComponent('https://app.example.com/x?ref=DEEP1')}`]);
    expect(searches.some((s) => referralCodeFromSearch(s, ['ref']) === 'DEEP1')).toBe(true);
    const rel = referralSearches([`?after_url=${encodeURIComponent('/welcome?via=REL22')}`], 'https://app.example.com/');
    expect(rel.some((s) => referralCodeFromSearch(s, ['via']) === 'REL22')).toBe(true);
  });

  it('parses the cookie: JSON, URL-encoded JSON, snake_case, or a plain click id', () => {
    expect(parseReferralCookie('{"code":"C01","clickId":"k_1"}')).toEqual({ code: 'C01', clickId: 'k_1', anonId: null });
    expect(parseReferralCookie(encodeURIComponent('{"anon_id":"an_1"}'))).toEqual({ code: null, clickId: null, anonId: 'an_1' });
    expect(parseReferralCookie('plain_click')).toEqual({ code: null, clickId: 'plain_click', anonId: null });
    expect(parseReferralCookie('no')).toBeNull();
    expect(parseReferralCookie('{"code":"!"}')).toBeNull();
  });

  it('consent: Cookie Munch decides when present (category, else fallback); else the app option', () => {
    expect(referralConsentGranted(ON, { consent: { referrals: true } }, undefined)).toBe(true);
    expect(referralConsentGranted(ON, { consent: { referrals: false, marketing: true } }, 'granted')).toBe(false);
    expect(referralConsentGranted(ON, { consent: { marketing: true } }, undefined)).toBe(true);
    expect(referralConsentGranted(ON, undefined, 'granted')).toBe(true);
    expect(referralConsentGranted(ON, undefined, true)).toBe(true);
    expect(referralConsentGranted(ON, undefined, () => 'granted')).toBe(true);
    expect(referralConsentGranted(ON, undefined, 'denied')).toBe(false);
    expect(referralConsentGranted(ON, undefined, undefined)).toBe(false);
    expect(referralConsentGranted(ON, undefined, () => {
      throw new Error('cmp down');
    })).toBe(false);
  });

  it('reads the cookie format {anonId, code, clickId, ts, exp}; an expired cookie is ignored', () => {
    const now = Date.parse('2026-10-21T12:00:00Z');
    const ts = now / 1000 - 60;
    const v = encodeURIComponent(JSON.stringify({ anonId: 'a_1', code: 'WJXQGLBW', clickId: 'clk_1', ts, exp: ts + 86400 }));
    expect(parseReferralCookie(v, now)).toEqual({
      code: 'WJXQGLBW',
      clickId: 'clk_1',
      anonId: 'a_1',
      capturedAt: new Date(ts * 1000).toISOString(),
    });
    expect(parseReferralCookie(JSON.stringify({ code: 'WJXQGLBW', exp: ts }), now)).toBeNull();
  });

  it('precedence: script, explicit params, URL code, cookie; never mixed', () => {
    const cookies = `acme_ref=${encodeURIComponent('{"code":"COOKIE1","clickId":"k_9"}')}`;
    const aff = { getReferral: () => ({ code: 'SCRIPT1', clickId: 'k_s', anonId: null, ts: 1_790_000_000_000 }) };
    // The script wins over everything, its id only with consent.
    expect(captureReferral(ON, { searches: ['?ref=URL001'], cookies, aff, capturedAt: 't' }, 'granted')).toEqual({
      code: 'SCRIPT1',
      click_id: 'k_s',
      anon_id: null,
      consent: 'granted',
      captured_at: new Date(1_790_000_000_000).toISOString(),
    });
    expect(captureReferral(ON, { searches: [''], aff, capturedAt: 't' })).toMatchObject({ code: 'SCRIPT1', click_id: null, consent: 'not_required' });
    // Explicit ref_* params carry their own consent.
    expect(
      captureReferral(ON, { searches: ['?ref=URL001&ref_click_id=k_e&ref_consent=granted'], cookies, capturedAt: 't' }),
    ).toEqual({ code: 'URL001', click_id: 'k_e', anon_id: null, consent: 'granted', captured_at: 't' });
    // A URL code never travels with the cookie's click id.
    expect(captureReferral(ON, { searches: ['?ref=URL001'], cookies, capturedAt: 't' }, 'granted')).toEqual({
      code: 'URL001',
      click_id: null,
      anon_id: null,
      consent: 'not_required',
      captured_at: 't',
    });
    expect(captureReferral(ON, { searches: [''], cookies, capturedAt: 't' }, 'granted')).toMatchObject({
      code: 'COOKIE1',
      click_id: 'k_9',
      consent: 'granted',
    });
    // No consent: the cookie's code alone.
    expect(captureReferral(ON, { searches: [''], cookies, capturedAt: 't' })).toMatchObject({ code: 'COOKIE1', click_id: null });
    // A broken script falls through to the next source.
    const broken = { getReferral: () => { throw new Error('x'); } };
    expect(captureReferral(ON, { searches: ['?via=VIA0001'], aff: broken })!.code).toBe('VIA0001');
    expect(captureReferral(ON, { searches: ['?ref=URL001'], cookies, capturedAt: 't' })).toEqual({
      code: 'URL001',
      click_id: null,
      anon_id: null,
      consent: 'not_required',
      captured_at: 't',
    });
    expect(captureReferral(ON, { searches: [''], cookies: `acme_ref=${encodeURIComponent('{"clickId":"k_9"}')}` })).toBeNull();
    expect(captureReferral({ ...ON, enabled: false }, { searches: ['?ref=URL001'] })).toBeNull();
  });

  it('only sign-in / sign-up starts and their continuing steps take referral', () => {
    expect(acceptsReferral('/v1/client/sign_ups')).toBe(true);
    expect(acceptsReferral('/v1/client/sign_ins')).toBe(true);
    expect(acceptsReferral('/v1/client/sign_ins/oauth')).toBe(true);
    expect(acceptsReferral('/v1/client/sign_ins/id_token/nonce')).toBe(true);
    expect(acceptsReferral('/v1/client/sign_ins/sia_1/prepare_first_factor')).toBe(true);
    expect(acceptsReferral('/v1/client/sign_ups/sua_1/attempt_verification')).toBe(true);
    expect(acceptsReferral('/v1/client/sign_ins/sia_1/attempt_second_factor')).toBe(false);
    expect(acceptsReferral('/v1/client/tickets/exchange')).toBe(false);
    expect(acceptsReferral('/v1/client/me')).toBe(false);
  });
});

describe('FapiClient sends the referral', () => {
  it('on a sign-up start, from the page URL, after one environment read per page', async () => {
    setUrl('/pricing?ref=FRIEND10');
    const { client: c, sent } = client();
    await c.post('/v1/client/sign_ups', { email: 'a@example.com', password: 'pw' });
    await c.post('/v1/client/sign_ins', { identifier: 'a@example.com' });
    const posts = sent.filter((s) => s.method === 'POST');
    expect(posts[0]!.body!.referral).toMatchObject({ code: 'FRIEND10', consent: 'not_required' });
    expect(posts[1]!.body!.referral).toMatchObject({ code: 'FRIEND10' });
    expect(sent.filter((s) => s.url.endsWith('/v1/client/environment'))).toHaveLength(1);
  });

  it('keeps the landing code after client-side navigation drops it', async () => {
    setUrl('/?via=LANDED1');
    const { client: c, sent } = client();
    setUrl('/sign-up');
    await c.post('/v1/client/sign_ups', { email: 'a@example.com', password: 'pw' });
    expect(sent.find((s) => s.method === 'POST')!.body!.referral).toMatchObject({ code: 'LANDED1' });
  });

  it('never on other requests, and never overrides a referral the caller set', async () => {
    setUrl('/?ref=FRIEND10');
    const { client: c, sent } = client();
    await c.post('/v1/client/tickets/exchange', { attempt_id: 'a', ticket: 't' });
    await c.post('/v1/client/sign_ups', { email: 'a@example.com', password: 'pw', referral: { code: 'MINE001' } });
    const posts = sent.filter((s) => s.method === 'POST');
    expect(posts[0]!.body!.referral).toBeUndefined();
    expect(posts[1]!.body!.referral).toEqual({ code: 'MINE001' });
  });

  it('asks nothing and sends nothing with no query and no config loaded', async () => {
    const { client: c, sent } = client();
    await c.post('/v1/client/sign_ins', { identifier: 'a@example.com' });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body!.referral).toBeUndefined();
  });

  it('sends nothing when the instance has referrals off', async () => {
    setUrl('/?ref=FRIEND10');
    const { client: c, sent } = client({ object: 'environment', referrals: { enabled: false } });
    await c.post('/v1/client/sign_ups', { email: 'a@example.com', password: 'pw' });
    expect(sent.find((s) => s.method === 'POST')!.body!.referral).toBeUndefined();
  });

  it('referral: false opts out, per client or page-wide', async () => {
    setUrl('/?ref=FRIEND10');
    let { client: c, sent } = client(ENV, {}, { referral: false });
    await c.post('/v1/client/sign_ups', { email: 'a@example.com', password: 'pw' });
    expect(sent.find((s) => s.method === 'POST')!.body!.referral).toBeUndefined();

    configureReferralCapture({ referral: false });
    ({ client: c, sent } = client());
    await c.post('/v1/client/sign_ups', { email: 'a@example.com', password: 'pw' });
    expect(sent.find((s) => s.method === 'POST')!.body!.referral).toBeUndefined();
  });

  it('reads the cookie ids with Cookie Munch consent, or with referralConsent when no CMP is on the page', async () => {
    document.cookie = `acme_ref=${encodeURIComponent('{"code":"FRIEND10","clickId":"clk_7"}')}`;

    let { client: c, sent } = client();
    // A cookie-only referral is sent once the config is loaded on the page.
    await c.get('/v1/client/environment');
    await c.post('/v1/client/sign_ups', { email: 'a@example.com', password: 'pw' });
    expect(sent.find((s) => s.method === 'POST')!.body!.referral).toMatchObject({ click_id: null, consent: 'not_required' });

    ({ client: c, sent } = client(ENV, {}, { referralConsent: 'granted' }));
    await c.post('/v1/client/sign_ups', { email: 'a@example.com', password: 'pw' });
    expect(sent.find((s) => s.method === 'POST')!.body!.referral).toMatchObject({ click_id: 'clk_7', consent: 'granted' });

    // Cookie Munch on the page decides, whatever the option says.
    win.CookieMunch = { consent: { referrals: false, marketing: false } };
    ({ client: c, sent } = client(ENV, {}, { referralConsent: 'granted' }));
    await c.post('/v1/client/sign_ups', { email: 'a@example.com', password: 'pw' });
    expect(sent.find((s) => s.method === 'POST')!.body!.referral).toMatchObject({ click_id: null });

    win.CookieMunch = { consent: { referrals: true } };
    ({ client: c, sent } = client());
    await c.post('/v1/client/sign_ups', { email: 'a@example.com', password: 'pw' });
    expect(sent.find((s) => s.method === 'POST')!.body!.referral).toMatchObject({ click_id: 'clk_7', consent: 'granted' });
  });

  it('an appearance read seeds the config (no environment request)', async () => {
    setUrl('/?ref=FRIEND10');
    const { client: c, sent } = client(ENV, { captchaFlows: {}, referrals: ENV.referrals });
    await c.get('/v1/appearance');
    await c.post('/v1/client/sign_ups', { email: 'a@example.com', password: 'pw' });
    expect(sent.some((s) => s.url.endsWith('/v1/client/environment'))).toBe(false);
    expect(sent.find((s) => s.method === 'POST')!.body!.referral).toMatchObject({ code: 'FRIEND10' });
  });
});

describe('referred sign-up challenge', () => {
  const alwaysEnv = { referrals: { ...ENV.referrals, challenge_referred_signups: 'always' } };
  const appearance = {
    captchaFlows: {
      signUp: { enabled: false, provider: 'turnstile', siteKey: 'k', widget: 'managed' },
      signIn: { enabled: false, provider: 'turnstile', siteKey: 'k', widget: 'managed' },
      passwordReset: { enabled: false, provider: 'turnstile', siteKey: 'k', widget: 'managed' },
    },
    ...alwaysEnv,
  };

  it('fetchInstanceSettings switches the sign-up and sign-in captcha on for a captured code', async () => {
    setUrl('/?ref=FRIEND10');
    const { client: c } = client(alwaysEnv, appearance);
    const settings = await fetchInstanceSettings(c);
    expect(settings!.captchaFlows.signUp!.enabled).toBe(true);
    expect(settings!.captchaFlows.signIn!.enabled).toBe(true);
    expect(settings!.captchaFlows.passwordReset!.enabled).toBe(false);
  });

  it('leaves it off without a code, with inherit, or when opted out', async () => {
    let { client: c } = client(alwaysEnv, appearance);
    expect((await fetchInstanceSettings(c))!.captchaFlows.signUp!.enabled).toBe(false);

    setUrl('/?ref=FRIEND10');
    ({ client: c } = client(ENV, { ...appearance, referrals: ENV.referrals }));
    expect((await fetchInstanceSettings(c))!.captchaFlows.signUp!.enabled).toBe(false);

    resetReferralCapture();
    ({ client: c } = client(alwaysEnv, appearance, { referral: false }));
    expect(await referralChallengeRequired(c)).toBe(false);
  });

  it('never invents a provider', () => {
    expect(referralChallengeFlows({ signUp: { enabled: false } })).toEqual({ signUp: { enabled: false } });
  });
});

describe('v2 capture on the FapiClient', () => {
  it("sends the page's referral script (window.aff) with no query and no config loaded yet", async () => {
    win.aff = { getReferral: () => ({ code: 'WJXQGLBW', clickId: 'clk_1', anonId: 'a_1', ts: 1_790_000_000 }) };
    let { client: c, sent } = client();
    await c.post('/v1/client/sign_ups', { email: 'a@example.com', password: 'pw' });
    expect(sent.find((s) => s.method === 'POST')!.body!.referral).toEqual({
      code: 'WJXQGLBW',
      click_id: null,
      anon_id: null,
      consent: 'not_required',
      captured_at: new Date(1_790_000_000_000).toISOString(),
    });
    // The consent callback is asked at each start.
    let ok = false;
    ({ client: c, sent } = client(ENV, {}, { referralConsent: () => (ok ? 'granted' : 'denied') }));
    ok = true;
    await c.post('/v1/client/sign_ups', { email: 'a@example.com', password: 'pw' });
    expect(sent.find((s) => s.method === 'POST')!.body!.referral).toMatchObject({ click_id: 'clk_1', anon_id: 'a_1', consent: 'granted' });
  });

  it('explicit ref_* on the page URL win over the cookie, ids by their own consent', async () => {
    setUrl('/?ref=EXPL001&ref_anon_id=a_9&ref_consent=granted&ref_captured_at=2026-10-21T10:00:00Z');
    document.cookie = `acme_ref=${encodeURIComponent('{"code":"COOKIE1","clickId":"clk_7"}')}`;
    const { client: c, sent } = client(ENV, {}, { referral: 'auto' });
    await c.post('/v1/client/sign_ins', { identifier: 'a@example.com' });
    expect(sent.find((s) => s.method === 'POST')!.body!.referral).toEqual({
      code: 'EXPL001',
      click_id: null,
      anon_id: 'a_9',
      consent: 'granted',
      captured_at: '2026-10-21T10:00:00.000Z',
    });
  });

  it('reads code_lookup_url and signup_code_field from the config', () => {
    const cfg = referralConfigFrom({
      referrals: { ...ENV.referrals, code_lookup_url: 'https://refs.example.com/t/tok/codes/{code}', signup_code_field: true },
    });
    expect(cfg).toMatchObject({ codeLookupUrl: 'https://refs.example.com/t/tok/codes/{code}', signupCodeField: true });
    expect(referralConfigFrom({ referrals: { ...ENV.referrals, code_lookup_url: 'javascript:{code}' } }).codeLookupUrl).toBeNull();
  });
});

describe('redirect helpers (ref_* parameters)', () => {
  it('referralParams: the script, then the URL; ids only with consent; default auto', () => {
    setUrl('/pricing?via=PARTNER7');
    expect(referralParams()).toEqual([
      ['ref', 'PARTNER7'],
      ['ref_consent', 'not_required'],
      ['ref_captured_at', expect.any(String)],
    ]);
    win.aff = { getReferral: () => ({ code: 'SCRIPT1', clickId: 'clk_1', anonId: null, ts: 1_790_000_000 }) };
    expect(referralParams({ consent: () => 'granted' })).toEqual([
      ['ref', 'SCRIPT1'],
      ['ref_click_id', 'clk_1'],
      ['ref_consent', 'granted'],
      ['ref_captured_at', new Date(1_790_000_000_000).toISOString()],
    ]);
    // Cookie Munch on the page counts as consent.
    win.CookieMunch = { consent: { referrals: true } };
    expect(referralParams().map(([k]) => k)).toContain('ref_click_id');
    expect(referralParams({ referral: false })).toEqual([]);
    configureReferralCapture({ referral: false });
    expect(referralParams()).toEqual([]);
  });

  it('withReferralParams keeps the URL and any ref params already there', () => {
    setUrl('/?ref=FRIEND10');
    const u = new URL(withReferralParams('https://accounts.example.com/hosted/sign-up?redirect_url=x'));
    expect(u.searchParams.get('redirect_url')).toBe('x');
    expect(u.searchParams.get('ref')).toBe('FRIEND10');
    expect(new URL(withReferralParams('https://a.example.com/x?ref=MINE001')).searchParams.get('ref')).toBe('MINE001');
    setUrl('/');
    expect(withReferralParams('https://a.example.com/x')).toBe('https://a.example.com/x');
  });

  it('signIn / signUp go to the hosted page (or url) with the referral', () => {
    setUrl('/?ref=FRIEND10');
    const to = signUp({ frontendApi: 'accounts.example.com', redirectUrl: 'https://app.example.com/home', navigate: false });
    const u = new URL(to);
    expect(u.origin + u.pathname).toBe('https://accounts.example.com/hosted/sign-up');
    expect(u.searchParams.get('redirect_url')).toBe('https://app.example.com/home');
    expect(u.searchParams.get('ref')).toBe('FRIEND10');
    const authorize = signIn({ url: 'https://accounts.example.com/oauth2/authorize?client_id=c', navigate: false });
    expect(new URL(authorize).searchParams.get('ref')).toBe('FRIEND10');
    expect(new URL(signIn({ frontendApi: 'https://accounts.example.com', referral: false, navigate: false })).search).toBe('');
    expect(() => signIn({ navigate: false })).toThrow();
  });
});

describe('lookupReferralCode', () => {
  const tpl = 'https://refs.example.com/t/tok/codes/{code}';
  const answer = (status: number, body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;

  it('valid / invalid answers', async () => {
    let seen = '';
    const f = (async (url: string, init: RequestInit) => {
      seen = url;
      expect(init.credentials).toBe('omit');
      return new Response(JSON.stringify({ valid: true, partnerDisplayName: 'Dana', refereeReward: '2% of your first top-up' }));
    }) as unknown as typeof fetch;
    expect(await lookupReferralCode(tpl, 'WJX_1', { fetchImpl: f })).toEqual({
      valid: true,
      partnerDisplayName: 'Dana',
      refereeReward: '2% of your first top-up',
    });
    expect(seen).toBe('https://refs.example.com/t/tok/codes/WJX_1');
    expect(await lookupReferralCode({ codeLookupUrl: tpl }, 'NOPE01', { fetchImpl: answer(200, { valid: false }) })).toEqual({ valid: false });
  });

  it('is null when there is no lookup, the code is malformed, or the lookup fails / hangs', async () => {
    expect(await lookupReferralCode(null, 'WJX_1', { fetchImpl: answer(200, { valid: true }) })).toBeNull();
    expect(await lookupReferralCode(tpl, 'a b', { fetchImpl: answer(200, { valid: true }) })).toBeNull();
    expect(await lookupReferralCode(tpl, 'WJX_1', { fetchImpl: answer(503, {}) })).toBeNull();
    expect(await lookupReferralCode(tpl, 'WJX_1', { fetchImpl: answer(200, { nope: 1 }) })).toBeNull();
    const down = (async () => {
      throw new TypeError('network');
    }) as unknown as typeof fetch;
    expect(await lookupReferralCode(tpl, 'WJX_1', { fetchImpl: down })).toBeNull();
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    expect(await lookupReferralCode(tpl, 'WJX_1', { fetchImpl: hang, timeoutMs: 20 })).toBeNull();
  });
});
