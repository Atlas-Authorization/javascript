// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acceptsReferral,
  captureReferral,
  configureReferralCapture,
  parseReferralCookie,
  referralChallengeRequired,
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
});
afterEach(() => {
  resetReferralCapture();
  delete win.CookieMunch;
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

  it('captures URL code + consented cookie; the URL code wins', () => {
    const cookies = `acme_ref=${encodeURIComponent('{"code":"COOKIE1","clickId":"k_9"}')}`;
    expect(captureReferral(ON, { searches: ['?ref=URL001'], cookies, capturedAt: 't' }, 'granted')).toEqual({
      code: 'URL001',
      click_id: 'k_9',
      anon_id: null,
      consent: 'granted',
      captured_at: 't',
    });
    expect(captureReferral(ON, { searches: [''], cookies, capturedAt: 't' }, 'granted')!.code).toBe('COOKIE1');
    expect(captureReferral(ON, { searches: ['?ref=URL001'], cookies, capturedAt: 't' })).toEqual({
      code: 'URL001',
      click_id: null,
      anon_id: null,
      consent: 'not_required',
      captured_at: 't',
    });
    expect(captureReferral(ON, { searches: [''], cookies })).toBeNull();
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

  it('reads the cookie with Cookie Munch consent, or with referralConsent when no CMP is on the page', async () => {
    setUrl('/?ref=FRIEND10');
    document.cookie = `acme_ref=${encodeURIComponent('{"clickId":"clk_7"}')}`;

    let { client: c, sent } = client();
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
