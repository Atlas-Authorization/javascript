/**
 * `@atlasauth/backend/link/testing` — a contract suite any {@link UserLink} must pass, for your own
 * test runner (vitest, jest, node:test): pass its `describe`, `it` and `expect`.
 *
 * ```ts
 * import { describe, it, expect } from 'vitest';
 * describeUserLinkContract(link, { describe, it, expect, reset: () => db.exec('delete from users'), seed });
 * ```
 */
import type { UserLink } from './index';

export interface UserLinkContractOptions {
  describe(name: string, fn: () => void): void;
  it(name: string, fn: () => Promise<void> | void): void;
  expect: (value: any) => any;
  /** Empty the user table before each case. */
  reset(): Promise<void> | void;
  /** Insert a pre-existing row of yours and return its id. `sub: null` means not yet bound to an Atlas user. */
  seed(row: { email: string; sub: string | null }): Promise<string | number>;
}

export function describeUserLinkContract(link: UserLink, o: UserLinkContractOptions): void {
  const { describe, it, expect } = o;
  // A schema with a unique email makes the "must not link" cases throw instead of creating a second row; both are safe.
  const resolveOrNull = async (c: Parameters<UserLink['resolve']>[0]) => {
    try {
      return await link.resolve(c);
    } catch {
      return null;
    }
  };

  describe('user link contract', () => {
    it('creates a row on first sight, then finds it by sub', async () => {
      await o.reset();
      const first = await link.resolve({ sub: 'u_1', email: 'a@example.com', email_verified: true });
      expect(first.created).toBe(true);
      const again = await link.resolve({ sub: 'u_1', email: 'a@example.com', email_verified: true });
      expect(again).toEqual({ localId: first.localId, created: false, linked: false });
    });

    it('concurrent first logins end on one row', async () => {
      await o.reset();
      const out = await Promise.all(Array.from({ length: 8 }, () => link.resolve({ sub: 'u_race', email: 'r@example.com', email_verified: true })));
      expect(new Set(out.map((r) => r.localId)).size).toBe(1);
      expect(out.filter((r) => r.created).length).toBe(1);
    });

    it('never links on an unverified email', async () => {
      await o.reset();
      const id = await o.seed({ email: 'v@example.com', sub: null });
      const r = await resolveOrNull({ sub: 'u_2', email: 'v@example.com', email_verified: false });
      expect(r === null || r.localId !== id).toBe(true);
      expect(r?.linked ?? false).toBe(false);
    });

    it('never takes a row bound to another sub', async () => {
      await o.reset();
      const id = await o.seed({ email: 'b@example.com', sub: 'someone_else' });
      const r = await resolveOrNull({ sub: 'u_3', email: 'b@example.com', email_verified: true });
      expect(r === null || r.localId !== id).toBe(true);
      expect(r?.linked ?? false).toBe(false);
    });

    it('never treats a placeholder address as an email', async () => {
      await o.reset();
      const id = await o.seed({ email: 'u_4@no-email.invalid', sub: null });
      const r = await link.resolve({ sub: 'u_4', email: 'u_4@no-email.invalid', email_verified: true });
      expect(r.localId).not.toBe(id);
      expect(r.created).toBe(true);
    });

    if (link.policy === 'strict') {
      it('strict: a verified email does not link an existing row', async () => {
        await o.reset();
        const id = await o.seed({ email: 's@example.com', sub: null });
        const r = await resolveOrNull({ sub: 'u_5', email: 'S@example.com', email_verified: true });
        expect(r === null || r.localId !== id).toBe(true);
      });
    } else {
      it('links the existing unbound row when the email is verified (case-insensitive)', async () => {
        await o.reset();
        const id = await o.seed({ email: 'Link@Example.com', sub: null });
        const r = await link.resolve({ sub: 'u_6', email: 'link@example.com', email_verified: true });
        expect(r).toEqual({ localId: id, created: false, linked: true });
        expect((await link.resolve({ sub: 'u_6', email: 'link@example.com', email_verified: true })).localId).toBe(id);
      });
    }
  });
}
