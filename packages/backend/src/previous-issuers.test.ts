import { describe, expect, it } from 'vitest';
import { PreviousIssuersFeed } from './previous-issuers';

const issuer = 'https://auth.example.com';

function feed(doc: unknown, state = { now: 1_000_000, ok: true }) {
  return new PreviousIssuersFeed({
    issuer,
    now: () => state.now,
    fetchImpl: (async () => (state.ok ? new Response(JSON.stringify(doc)) : new Response('', { status: 500 }))) as typeof fetch,
  });
}

describe('PreviousIssuersFeed', () => {
  it('accepts listed issuers until their own end date', async () => {
    const state = { now: 1_000_000, ok: true };
    const f = feed({ issuer, atlas_previous_issuers: [{ issuer: 'https://old.example.com/', accepted_until: 1_000 + 60 }, { issuer: 'http://insecure.example.com', accepted_until: 99999999 }] }, state);
    expect(await f.get()).toEqual(['https://old.example.com']);
    state.now += 61_000;
    expect(await f.get()).toEqual([]);
  });

  it('ignores a document about another issuer and keeps the last good list through an outage', async () => {
    expect(await feed({ issuer: 'https://evil.example.com', atlas_previous_issuers: [{ issuer: 'https://x.example.com', accepted_until: 99999999 }] }).get()).toEqual([]);
    const state = { now: 1_000_000, ok: true };
    const f = feed({ issuer, atlas_previous_issuers: [{ issuer: 'https://old.example.com', accepted_until: 99999999 }] }, state);
    expect(await f.get()).toEqual(['https://old.example.com']);
    state.ok = false;
    state.now += 4_000_000;
    expect(await f.get()).toEqual(['https://old.example.com']);
  });
});
