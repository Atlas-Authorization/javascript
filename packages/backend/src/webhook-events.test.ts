import { createHmac } from 'node:crypto';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { ATLAS_WEBHOOK_EVENT_TYPES, type AtlasWebhookEvent, type RoleSource } from './webhook-events';
import { verifyWebhook } from './webhooks';

describe('AtlasWebhookEvent', () => {
  it('narrows on type', () => {
    const secret = 'whsec_test';
    const body = JSON.stringify({
      id: 'evt_1', type: 'organization_membership.updated', timestamp: Date.now(), instance_id: 'ins_1',
      data: { object: 'organization_membership', id: 'mem_1', organization_id: 'org_1', user_id: 'user_1', role_id: 'role_1', created_at: 1, role_source: 'scim' },
    });
    const ts = Date.now();
    const sig = createHmac('sha256', secret).update(`msg_1.${ts}.${body}`).digest('base64');
    const { verified, event } = verifyWebhook({ body, secret, headers: { 'atlas-id': 'msg_1', 'atlas-timestamp': String(ts), 'atlas-signature': `v1,${sig}` } });
    expect(verified).toBe(true);
    expectTypeOf(event).toEqualTypeOf<AtlasWebhookEvent | undefined>();
    if (event?.type === 'organization_membership.updated') {
      expectTypeOf(event.data.organization_id).toEqualTypeOf<string>();
      expect(event.data.role_source).toBe('scim');
    } else {
      throw new Error('not narrowed');
    }
  });

  it('lists every event type once', () => {
    expect(new Set(ATLAS_WEBHOOK_EVENT_TYPES).size).toBe(ATLAS_WEBHOOK_EVENT_TYPES.length);
    expect(ATLAS_WEBHOOK_EVENT_TYPES).toContain('user.created');
    expect(ATLAS_WEBHOOK_EVENT_TYPES.length).toBeGreaterThan(60);
  });

  it('RoleSource covers every value the server writes', () => {
    const all: RoleSource[] = ['manual', 'scim', 'directory_sync', 'sso:sso_1', 'ldap:ldap_1'];
    expect(all).toHaveLength(5);
    // @ts-expect-error not a role source
    const bad: RoleSource = 'saml';
    void bad;
  });
});
