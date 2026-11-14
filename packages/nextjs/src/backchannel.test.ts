import { describe, expect, it } from 'vitest';
import { LogoutDenylist } from './backchannel';

describe('LogoutDenylist', () => {
  it('ends a named session and nothing else', () => {
    const d = new LogoutDenylist();
    d.add({ sid: 'sess_1', sub: 'user_1' });
    expect(d.has({ sid: 'sess_1', sub: 'user_1', iat: 1 })).toBe(true);
    expect(d.has({ sid: 'sess_2', sub: 'user_1', iat: 1 })).toBe(false);
  });

  it('ends every session minted before a user-wide logout, but not a later sign-in', () => {
    let t = 10_000_000;
    const d = new LogoutDenylist({ now: () => t, ttlSeconds: 3600 });
    d.add({ sub: 'user_1' });
    expect(d.has({ sid: 'old', sub: 'user_1', iat: Math.floor(t / 1000) - 60 })).toBe(true);
    t += 5_000;
    expect(d.has({ sid: 'new', sub: 'user_1', iat: Math.floor(t / 1000) + 1 })).toBe(false);
    expect(d.has({ sid: 'other', sub: 'user_2', iat: 1 })).toBe(false);
  });

  it('forgets after the ttl and stays bounded', () => {
    let t = 1_000;
    const d = new LogoutDenylist({ now: () => t, ttlSeconds: 10, maxEntries: 3 });
    d.add({ sid: 'a', sub: 'u' });
    t += 11_000;
    expect(d.has({ sid: 'a', sub: 'u', iat: 0 })).toBe(false);
    for (const sid of ['b', 'c', 'd', 'e']) d.add({ sid, sub: 'u' });
    expect(d.has({ sid: 'e', sub: 'u', iat: 0 })).toBe(true);
    expect(d.has({ sid: 'b', sub: 'u', iat: 0 })).toBe(false); // the oldest made room
  });
});
