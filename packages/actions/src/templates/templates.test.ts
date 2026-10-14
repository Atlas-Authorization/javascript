import { describe, expect, it } from 'vitest';
import { createTestEvent, runAction, runScript } from '../harness';
import type { ActionTrigger } from '../types';
import { getTemplate, templates } from './index';

describe('template gallery manifest', () => {
  it('lists five templates with unique slugs and valid triggers', () => {
    expect(templates).toHaveLength(5);
    const slugs = templates.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const t of templates) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(['post_login', 'pre_user_registration', 'post_user_registration']).toContain(
        t.trigger,
      );
      expect(t.action.trigger).toBe(t.trigger);
    }
  });

  it('getTemplate resolves by slug', () => {
    expect(getTemplate('add-roles-to-token')?.title).toBe('Add roles to token');
    expect(getTemplate('nope')).toBeUndefined();
  });

  it('every template serializes to a deployable, re-runnable code body', async () => {
    for (const t of templates) {
      const code = t.action.toCode();
      expect(code).toContain('event');
      expect(code).toContain('api');
      // The serialized code runs through the harness without throwing.
      const result = await runScript(code, createTestEvent(t.trigger as ActionTrigger));
      expect(result.error).toBeNull();
    }
  });
});

describe('enforce-email-domain-allowlist', () => {
  const action = getTemplate('enforce-email-domain-allowlist')!.action;

  it('denies an off-allowlist domain', async () => {
    const result = await runAction(
      action.handler,
      createTestEvent('pre_user_registration', {
        user: { email: 'eve@evil.com' },
        secrets: { ALLOWED_EMAIL_DOMAINS: 'acme.com, acme.io' },
      }),
    );
    expect(result.denied).toBe(true);
  });

  it('allows an on-allowlist domain', async () => {
    const result = await runAction(
      action.handler,
      createTestEvent('pre_user_registration', {
        user: { email: 'ada@acme.io' },
        secrets: { ALLOWED_EMAIL_DOMAINS: 'acme.com, acme.io' },
      }),
    );
    expect(result.denied).toBe(false);
  });

  it('allows everyone when the secret is unset', async () => {
    const result = await runAction(
      action.handler,
      createTestEvent('pre_user_registration', { user: { email: 'x@anywhere.com' } }),
    );
    expect(result.denied).toBe(false);
  });
});

describe('block-disposable-emails', () => {
  const action = getTemplate('block-disposable-emails')!.action;

  it('blocks a known disposable domain', async () => {
    const result = await runAction(
      action.handler,
      createTestEvent('pre_user_registration', { user: { email: 'spam@mailinator.com' } }),
    );
    expect(result.denied).toBe(true);
  });

  it('blocks a domain added via EXTRA_DISPOSABLE_DOMAINS', async () => {
    const result = await runAction(
      action.handler,
      createTestEvent('pre_user_registration', {
        user: { email: 'u@burner.test' },
        secrets: { EXTRA_DISPOSABLE_DOMAINS: 'burner.test' },
      }),
    );
    expect(result.denied).toBe(true);
  });

  it('allows a normal domain', async () => {
    const result = await runAction(
      action.handler,
      createTestEvent('pre_user_registration', { user: { email: 'real@gmail.com' } }),
    );
    expect(result.denied).toBe(false);
  });
});

describe('add-roles-to-token', () => {
  const action = getTemplate('add-roles-to-token')!.action;

  it('copies roles from metadata into namespaced claims', async () => {
    const result = await runAction(
      action.handler,
      createTestEvent('post_login', {
        user: { metadata: { roles: ['admin', 'billing'] } },
        secrets: { CLAIM_NAMESPACE: 'https://acme.test' },
      }),
    );
    expect(result.idTokenClaims['https://acme.test/roles']).toEqual(['admin', 'billing']);
    expect(result.accessTokenClaims['https://acme.test/roles']).toEqual(['admin', 'billing']);
  });

  it('defaults to an empty roles array when none are set', async () => {
    const result = await runAction(action.handler, createTestEvent('post_login'));
    expect(result.idTokenClaims['https://atlasauth.net/roles']).toEqual([]);
  });
});

describe('enrich-profile-from-secrets', () => {
  const action = getTemplate('enrich-profile-from-secrets')!.action;

  it('derives the plan from the domain map and stamps claim + metadata', async () => {
    const result = await runAction(
      action.handler,
      createTestEvent('post_login', {
        user: { email: 'ceo@acme.com' },
        secrets: { PLAN_BY_DOMAIN: JSON.stringify({ 'acme.com': 'enterprise' }) },
      }),
    );
    expect(result.idTokenClaims['https://atlasauth.net/plan']).toBe('enterprise');
    expect(result.appMetadata.plan).toBe('enterprise');
  });

  it('falls back to free for an unknown domain or malformed secret', async () => {
    const result = await runAction(
      action.handler,
      createTestEvent('post_login', {
        user: { email: 'nobody@unknown.com' },
        secrets: { PLAN_BY_DOMAIN: 'not json' },
      }),
    );
    expect(result.appMetadata.plan).toBe('free');
    expect(result.error).toBeNull();
  });
});

describe('restrict-signin-by-ip', () => {
  const action = getTemplate('restrict-signin-by-ip')!.action;

  it('denies an IP outside the allowed prefixes', async () => {
    const result = await runAction(
      action.handler,
      createTestEvent('post_login', {
        request: { ip: '8.8.8.8' },
        secrets: { ALLOWED_IP_PREFIXES: '10.,192.168.' },
      }),
    );
    expect(result.denied).toBe(true);
  });

  it('allows an IP on an allowed prefix', async () => {
    const result = await runAction(
      action.handler,
      createTestEvent('post_login', {
        request: { ip: '192.168.1.20' },
        secrets: { ALLOWED_IP_PREFIXES: '10.,192.168.' },
      }),
    );
    expect(result.denied).toBe(false);
  });

  it('allows all when unconfigured', async () => {
    const result = await runAction(
      action.handler,
      createTestEvent('post_login', { request: { ip: '8.8.8.8' } }),
    );
    expect(result.denied).toBe(false);
  });
});
