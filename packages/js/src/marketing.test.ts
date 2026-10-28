import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FapiClient, FapiResponse } from './fapi';
import { captureMarketing, flushMarketing, marketingTouchFromPage, resetMarketingCapture, storedMarketing, submitLead } from './marketing';

const memory = () => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
};
const ok = (data: unknown): FapiResponse<unknown> => ({ ok: true, status: 200, data, errors: [] });

function fakeClient(config: unknown, post: (path: string, body: unknown) => FapiResponse<unknown> = () => ok({ recorded: true })) {
  const posts: Array<{ path: string; body: unknown }> = [];
  const client = {
    referralCacheKey: `k${Math.random()}`,
    get: async () => ok(config),
    post: async (path: string, body: unknown) => {
      posts.push({ path, body });
      return post(path, body);
    },
  } as unknown as FapiClient;
  return { client, posts };
}

const page = (search: string, referrer = '') => ({
  location: { search, origin: 'https://shop.example.com', pathname: '/landing' },
  document: { referrer },
  // The page's consent manager (a published __atlasConsent) decides.
  __atlasConsent: { version: 1, has: (c: string) => (c === 'marketing' ? true : null) },
});
const CONFIG = { object: 'marketing_config', capture: { enabled: true, params: ['utm_source', 'utm_campaign', 'gclid'], consent_category: 'marketing' } };

afterEach(() => resetMarketingCapture());

describe('marketingTouchFromPage', () => {
  it('keeps only the allowed parameters and reduces URLs to origin + path', () => {
    const t = marketingTouchFromPage(
      { enabled: true, params: ['utm_source', 'gclid'], consentCategory: 'marketing' },
      page('?utm_source=news&utm_medium=email&gclid=abc&token=secret', 'https://google.com/search?q=x'),
    );
    expect(t).toMatchObject({ params: { utm_source: 'news', gclid: 'abc' }, landing_url: 'https://shop.example.com/landing', referrer: 'https://google.com/search' });
    expect(t!.params).not.toHaveProperty('token');
    expect(marketingTouchFromPage({ enabled: true, params: ['utm_source'], consentCategory: 'marketing' }, page('?foo=1'))).toBeNull();
  });
});

describe('captureMarketing', () => {
  it('stores a touch only when the instance captures and the visitor consented', async () => {
    const storage = memory();
    const { client } = fakeClient(CONFIG);
    expect(await captureMarketing(client, { win: page('?utm_source=a') as never, storage })).toBe(true);
    expect(storedMarketing({ storage })!.first_touch.params).toEqual({ utm_source: 'a' });

    // No consent decision at all -> nothing stored.
    const none = memory();
    const w = { ...page('?utm_source=a'), __atlasConsent: undefined };
    expect(await captureMarketing(fakeClient(CONFIG).client, { win: w as never, storage: none })).toBe(false);
    expect(storedMarketing({ storage: none })).toBeNull();

    // Instance has capture off -> nothing stored.
    expect(await captureMarketing(fakeClient({ capture: { enabled: false } }).client, { win: page('?utm_source=a') as never, storage: memory() })).toBe(false);
  });

  it('keeps the first touch and follows the last', async () => {
    const storage = memory();
    const { client } = fakeClient(CONFIG);
    await captureMarketing(client, { win: page('?utm_source=first') as never, storage });
    await captureMarketing(client, { win: page('?utm_source=second&utm_campaign=c') as never, storage });
    const s = storedMarketing({ storage })!;
    expect(s.first_touch.params.utm_source).toBe('first');
    expect(s.last_touch.params).toEqual({ utm_source: 'second', utm_campaign: 'c' });
  });
});

describe('flushMarketing and submitLead', () => {
  it('sends the stored attribution once for the new user', async () => {
    const storage = memory();
    const { client, posts } = fakeClient(CONFIG);
    await captureMarketing(client, { win: page('?utm_source=a') as never, storage });
    expect(await flushMarketing(client, { storage })).toBe(true);
    expect(posts[0]!.path).toBe('/v1/client/me/marketing');
    expect(posts[0]!.body).toMatchObject({ params: { utm_source: 'a' }, first_touch: { params: { utm_source: 'a' } } });
    // Sent once.
    expect(await flushMarketing(client, { storage })).toBe(false);
    expect(posts).toHaveLength(1);
  });

  it('a lead carries the first touch; the honeypot and consent ride along', async () => {
    const storage = memory();
    const { client, posts } = fakeClient(CONFIG);
    await captureMarketing(client, { win: page('?utm_source=a') as never, storage });
    const out = await submitLead(client, { email: 'a@b.co', name: 'Ann', form: 'newsletter', consent: true }, { storage });
    expect(out.ok).toBe(true);
    expect(posts[0]).toMatchObject({ path: '/v1/client/marketing/leads', body: { email: 'a@b.co', name: 'Ann', form: 'newsletter', consent: true, marketing: { params: { utm_source: 'a' } } } });
    vi.restoreAllMocks();
  });
});
