import { describe, expect, it } from 'vitest';
import { createAccessControl } from './access-control';
import type { SessionClaims } from './verify';

const ac = createAccessControl({
  tickets: ['read', 'write', 'close'],
  billing: ['read', 'refund'],
} as const);

const claims = (perms: string[]) =>
  ({ iss: 'i', sub: 'u', sid: 's', exp: 0, app_roles: ['support'], app_permissions: perms }) as SessionClaims;

describe('createAccessControl', () => {
  it('builds typed permission keys and role definitions', () => {
    expect(ac.permission('tickets', 'close')).toBe('tickets:close');
    expect(ac.role('support', 'Support', { tickets: ['write', 'read'] })).toEqual({
      key: 'support',
      name: 'Support',
      permissions: ['tickets:read', 'tickets:write'],
    });
    expect(ac.allPermissions()).toEqual([
      'billing:read',
      'billing:refund',
      'tickets:close',
      'tickets:read',
      'tickets:write',
    ]);
  });

  it('checks a grant against app_permissions (all / any)', () => {
    const c = claims(['tickets:read', 'tickets:write']);
    expect(ac.can(c, { tickets: ['read'] })).toBe(true);
    expect(ac.can(c, { tickets: ['read', 'close'] })).toBe(false);
    expect(ac.canAny(c, { tickets: ['close'], billing: ['read'] })).toBe(false);
    expect(ac.canAny(c, { tickets: ['close', 'write'] })).toBe(true);
    expect(ac.can(null, { tickets: ['read'] })).toBe(false);
  });

  it('refuses unknown resources/actions at runtime and bad statements up front', () => {
    expect(() => ac.permissions({ nope: ['x'] } as never)).toThrow(/Unknown resource/);
    expect(() => ac.permissions({ tickets: ['delete'] } as never)).toThrow(/Unknown action/);
    expect(() => createAccessControl({ org: ['read'] })).toThrow();
    expect(() => createAccessControl({ Tickets: ['read'] })).toThrow();
  });
});
