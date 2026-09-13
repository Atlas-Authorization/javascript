import { describe, expect, it } from 'vitest';
import {
  evaluate,
  hasFromClaims,
  protectFromClaims,
  ForbiddenError,
  isRoleKey,
  isPermissionKey,
  type AuthzClaims,
} from './index';

const signedOut = null;
const noOrg: AuthzClaims = { org_id: null, org_role: null, org_permissions: [] };
const member: AuthzClaims = {
  org_id: 'org_1',
  org_role: 'org:member',
  org_permissions: ['org:sys_memberships:read'],
};
const admin: AuthzClaims = {
  org_id: 'org_1',
  org_role: 'org:admin',
  org_permissions: ['org:sys_memberships:read', 'org:sys_memberships:manage', 'org:billing:manage'],
};

describe('evaluate — the one shared authorization contract', () => {
  it('signed out fails everything, including an empty condition', () => {
    expect(evaluate(signedOut)).toEqual({ allowed: false, reason: 'signed_out' });
    expect(evaluate(signedOut, { permission: 'org:x:manage' })).toEqual({
      allowed: false,
      reason: 'signed_out',
    });
  });

  it('an empty condition means "signed in" for any authenticated user', () => {
    expect(evaluate(member)).toEqual({ allowed: true });
    expect(evaluate(noOrg)).toEqual({ allowed: true });
  });

  it('no active org FAILS an org condition rather than passing vacuously', () => {
    // The exact case the old React/Next.js has() disagreed on.
    expect(evaluate(noOrg, { allPermissions: [] })).toEqual({
      allowed: false,
      reason: 'no_organization',
    });
    expect(evaluate(noOrg, { permission: 'org:billing:manage' })).toEqual({
      allowed: false,
      reason: 'no_organization',
    });
  });

  it('single permission', () => {
    expect(hasFromClaims(admin, { permission: 'org:billing:manage' })).toBe(true);
    expect(hasFromClaims(member, { permission: 'org:billing:manage' })).toBe(false);
  });

  it('role match', () => {
    expect(hasFromClaims(admin, { role: 'org:admin' })).toBe(true);
    expect(hasFromClaims(member, { role: 'org:admin' })).toBe(false);
  });

  it('anyPermission is OR, allPermissions is AND', () => {
    expect(hasFromClaims(member, { anyPermission: ['org:billing:manage', 'org:sys_memberships:read'] })).toBe(true);
    expect(hasFromClaims(member, { anyPermission: ['org:billing:manage'] })).toBe(false);
    expect(hasFromClaims(admin, { allPermissions: ['org:sys_memberships:manage', 'org:billing:manage'] })).toBe(true);
    expect(hasFromClaims(member, { allPermissions: ['org:sys_memberships:read', 'org:billing:manage'] })).toBe(false);
  });

  it('protectFromClaims throws ForbiddenError carrying the reason + condition', () => {
    expect(() => protectFromClaims(admin, { permission: 'org:billing:manage' })).not.toThrow();
    try {
      protectFromClaims(member, { permission: 'org:billing:manage' });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ForbiddenError);
      expect((e as ForbiddenError).reason).toBe('missing_permission');
      expect((e as ForbiddenError).condition).toEqual({ permission: 'org:billing:manage' });
    }
    expect(() => protectFromClaims(signedOut)).toThrow(ForbiddenError);
  });
});

describe('key shapes', () => {
  it('distinguishes role keys from permission keys by arity', () => {
    expect(isRoleKey('org:admin')).toBe(true);
    expect(isRoleKey('org:billing:manage')).toBe(false);
    expect(isPermissionKey('org:billing:manage')).toBe(true);
    expect(isPermissionKey('org:admin')).toBe(false);
    expect(isRoleKey('admin')).toBe(false);
    expect(isPermissionKey('billing:manage')).toBe(false);
  });
});
