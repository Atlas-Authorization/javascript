import { describe, expect, it } from 'vitest';
import {
  DomainHandoffError,
  createDomainHandoff,
  redeemDomainHandoff,
  type DomainHandoffClient,
} from './domain-handoff';

/** An in-memory stand-in for the ticket endpoints: single use, like the real ones. */
function fakeAtlas() {
  const store = new Map<string, unknown>();
  const created: Array<Record<string, unknown>> = [];
  const atlas: DomainHandoffClient = {
    tickets: {
      async create(body) {
        created.push(body as unknown as Record<string, unknown>);
        const secret = `tkt_${store.size}_${Math.random().toString(36).slice(2)}`;
        store.set(secret, body.payload);
        return { object: 'ticket', id: 't', ticket: secret, single_use: true, bound_user: null, bound_org: null, created_at: 1, expires_at: 2 } as never;
      },
      async redeem(body) {
        if (!store.has(body.ticket)) throw new Error('404');
        const payload = store.get(body.ticket);
        store.delete(body.ticket);
        return { object: 'ticket_redemption', id: 't', payload, single_use: true } as never;
      },
    },
  };
  return { atlas, created };
}

describe('domain handoff', () => {
  it('hands a signed-in user to the tenant domain, once', async () => {
    const { atlas } = fakeAtlas();
    const h = await createDomainHandoff(atlas, { userId: 'user_1', targetUrl: 'https://shop.example.com/auth/callback', returnTo: '/cart' });
    expect(new URL(h.url).origin).toBe('https://shop.example.com');
    expect(new URL(h.url).searchParams.get('code')).toBe(h.code);
    const who = await redeemDomainHandoff(atlas, h.code, { expectedOrigin: 'https://shop.example.com' });
    expect(who).toEqual({ userId: 'user_1', returnTo: '/cart', organizationId: null });
    await expect(redeemDomainHandoff(atlas, h.code, { expectedOrigin: 'https://shop.example.com' })).rejects.toMatchObject({ code: 'invalid_code' });
  });

  it('a code minted for one tenant domain does not sign anyone in on another, and is burnt by the attempt', async () => {
    const { atlas } = fakeAtlas();
    const h = await createDomainHandoff(atlas, { userId: 'user_1', targetUrl: 'https://shop-a.example.com/cb' });
    await expect(redeemDomainHandoff(atlas, h.code, { expectedOrigin: 'https://shop-b.example.com' })).rejects.toMatchObject({ code: 'audience_mismatch' });
    await expect(redeemDomainHandoff(atlas, h.code, { expectedOrigin: 'https://shop-a.example.com' })).rejects.toMatchObject({ code: 'invalid_code' });
  });

  it('refuses a ticket that is not a handoff code', async () => {
    const { atlas } = fakeAtlas();
    const other = await atlas.tickets.create({ ttl_seconds: 60, payload: { kind: 'something_else', user_id: 'user_1' } });
    await expect(redeemDomainHandoff(atlas, other.ticket, { expectedOrigin: 'https://shop.example.com' })).rejects.toMatchObject({ code: 'not_a_handoff' });
  });

  it('rejects an insecure or malformed target, and clamps the lifetime', async () => {
    const { atlas, created } = fakeAtlas();
    await expect(createDomainHandoff(atlas, { userId: 'u', targetUrl: 'http://shop.example.com/cb' })).rejects.toBeInstanceOf(DomainHandoffError);
    await expect(createDomainHandoff(atlas, { userId: 'u', targetUrl: 'not a url' })).rejects.toMatchObject({ code: 'invalid_target' });
    await createDomainHandoff(atlas, { userId: 'u', targetUrl: 'http://localhost:3000/cb', ttlSeconds: 99999 });
    expect(created[0]!.ttl_seconds).toBe(300);
  });

  it('carries the organization it was issued for', async () => {
    const { atlas } = fakeAtlas();
    const h = await createDomainHandoff(atlas, { userId: 'user_1', targetUrl: 'https://shop.example.com/cb', organizationId: 'org_1' });
    expect((await redeemDomainHandoff(atlas, h.code, { expectedOrigin: 'https://shop.example.com' })).organizationId).toBe('org_1');
  });
});
