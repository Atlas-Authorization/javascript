import { describe, expect, it } from 'vitest';
import { journeyRedirectFrom, journeyRedirectUrl } from './journey-redirect';

describe('journey redirect', () => {
  it('honours only https URLs', () => {
    expect(journeyRedirectUrl({ redirect_url: 'https://app.example.com/welcome' })).toBe('https://app.example.com/welcome');
    expect(journeyRedirectUrl({ redirect_url: 'javascript:alert(1)' })).toBeNull();
    expect(journeyRedirectUrl({ redirect_url: 'http://app.example.com' })).toBeNull();
    expect(journeyRedirectUrl({})).toBeNull();
    expect(journeyRedirectUrl(null)).toBeNull();
  });

  it('reads it off a response without consuming the body', async () => {
    const res = new Response(JSON.stringify({ object: 'session', redirect_url: 'https://app.example.com/next' }), { status: 200 });
    expect(await journeyRedirectFrom(res)).toBe('https://app.example.com/next');
    expect((await res.json()).object).toBe('session');
    expect(await journeyRedirectFrom(new Response('{}', { status: 403 }))).toBeNull();
  });
});
