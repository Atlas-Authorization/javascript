import { describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../../config-http';
import type { CollectionSpec, SingletonSpec } from '../config';
import { registeredConfigTypes } from './index';
import { MESSAGING_DELIVERY_SPECS } from './messaging-delivery';

class Http implements ConfigHttp {
  calls: Array<{ method: string; path: string; body?: unknown }> = [];
  constructor(private answers: Record<string, unknown> = {}) {}
  async get<T>(path: string): Promise<T> {
    this.calls.push({ method: 'GET', path });
    return (this.answers[path] ?? { data: [] }) as T;
  }
  async post<T>(path: string, body: unknown): Promise<T> {
    this.calls.push({ method: 'POST', path, body });
    return {} as T;
  }
  async put<T>(path: string, body: unknown): Promise<T> {
    this.calls.push({ method: 'PUT', path, body });
    return {} as T;
  }
  async patch<T>(path: string, body: unknown): Promise<T> {
    this.calls.push({ method: 'PATCH', path, body });
    return {} as T;
  }
  async delete(path: string): Promise<void> {
    this.calls.push({ method: 'DELETE', path });
  }
}

const settings = MESSAGING_DELIVERY_SPECS.find((s) => s.type === 'messaging_settings') as SingletonSpec;
const routes = MESSAGING_DELIVERY_SPECS.find((s) => s.type === 'sms_country_routes') as CollectionSpec;
const fallbacks = MESSAGING_DELIVERY_SPECS.find((s) => s.type === 'messaging_fallbacks') as CollectionSpec;

describe('messaging delivery config types', () => {
  it('registers all three and never prunes the collections by default', () => {
    const types = registeredConfigTypes().map((s) => s.type);
    for (const t of ['messaging_settings', 'sms_country_routes', 'messaging_fallbacks']) expect(types).toContain(t);
    expect(routes.prune).toBe(false);
    expect(fallbacks.prune).toBe(false);
  });
});

describe('messaging_settings', () => {
  it('reads only the settable keys, and writes them back with PUT', async () => {
    const http = new Http({ '/v1/messaging/settings': { object: 'messaging_settings', auto_suppress: true, failover_enabled: false, ledger_retention_days: 30, updated_at: 5 } });
    expect(await settings.fetchLive(http)).toEqual({ auto_suppress: true, failover_enabled: false, ledger_retention_days: 30 });
    await settings.apply(http, { auto_suppress: false, ledger_retention_days: 60, ignored: 'x' }, {} as never);
    expect(http.calls.at(-1)).toEqual({ method: 'PUT', path: '/v1/messaging/settings', body: { auto_suppress: false, ledger_retention_days: 60 } });
  });
});

describe('sms_country_routes', () => {
  it('keys by upper-cased country and reads provider ids', async () => {
    const http = new Http({ '/v1/messaging/country_routes': { data: [{ country: 'de', provider_id: 'mfb_1', id: 'r1', updated_at: 1 }] } });
    expect(routes.keyOf({ country: 'de', provider_id: 'x' })).toBe('DE');
    expect(await routes.fetchLive(http)).toEqual([{ key: 'DE', id: 'de', config: { country: 'DE', provider_id: 'mfb_1' } }]);
  });

  it('creates and updates through the one PUT route, and deletes by country', async () => {
    const http = new Http();
    await routes.create(http, { country: 'DE', provider_id: 'mfb_1' });
    await routes.update!(http, { key: 'DE', id: 'DE', config: {} }, { country: 'DE', provider_id: 'mfb_2' });
    await routes.remove!(http, { key: 'DE', id: 'DE', config: {} });
    expect(http.calls).toEqual([
      { method: 'PUT', path: '/v1/messaging/country_routes', body: { country: 'DE', provider_id: 'mfb_1' } },
      { method: 'PUT', path: '/v1/messaging/country_routes', body: { country: 'DE', provider_id: 'mfb_2' } },
      { method: 'DELETE', path: '/v1/messaging/country_routes/DE' },
    ]);
  });
});

describe('messaging_fallbacks', () => {
  it('keys by channel, transport and sender', () => {
    expect(fallbacks.keyOf({ channel: 'sms', transport: 'vonage', from_address: 'Acme' })).toBe('sms/vonage/Acme');
    expect(fallbacks.keyOf({ channel: 'email', transport: 'resend' })).toBe('email/resend/-');
  });

  it('reads every channel and never exposes secrets', async () => {
    const http = new Http({
      '/v1/messaging_providers/sms/fallbacks': { data: [{ id: 'mfb_1', transport: 'vonage', from_address: 'Acme', config: { api_key: 'vk' }, secrets_set: { api_secret: true }, position: 1, status: 'active' }] },
    });
    const live = await fallbacks.fetchLive(http);
    expect(http.calls.map((c) => c.path)).toEqual(['/v1/messaging_providers/email/fallbacks', '/v1/messaging_providers/sms/fallbacks', '/v1/messaging_providers/push/fallbacks']);
    expect(live).toEqual([{ key: 'sms/vonage/Acme', id: 'sms:mfb_1', config: { channel: 'sms', transport: 'vonage', from_address: 'Acme', config: { api_key: 'vk' }, position: 1, status: 'active' } }]);
    expect(JSON.stringify(live)).not.toContain('secret');
    expect(fallbacks.writeOnly).toEqual(['secrets']);
  });

  it('sends credentials with the settings on create and update, and removes by channel and id', async () => {
    const http = new Http();
    const entry = { channel: 'sms', transport: 'vonage', from_address: 'Acme', config: { region: 'eu' }, secrets: { api_secret: 'shh' }, position: 2 };
    await fallbacks.create(http, entry);
    await fallbacks.update!(http, { key: 'k', id: 'sms:mfb_1', config: {} }, { ...entry, status: 'disabled' });
    await fallbacks.remove!(http, { key: 'k', id: 'sms:mfb_1', config: {} });
    expect(http.calls).toEqual([
      { method: 'POST', path: '/v1/messaging_providers/sms/fallbacks', body: { transport: 'vonage', from_address: 'Acme', position: 2, config: { region: 'eu', api_secret: 'shh' } } },
      { method: 'PUT', path: '/v1/messaging_providers/sms/fallbacks/mfb_1', body: { transport: 'vonage', from_address: 'Acme', position: 2, status: 'disabled', config: { region: 'eu', api_secret: 'shh' } } },
      { method: 'DELETE', path: '/v1/messaging_providers/sms/fallbacks/mfb_1' },
    ]);
  });

  it('refuses an unknown channel locally', () => {
    expect(fallbacks.validate!({ channel: 'fax', transport: 'x' })).toHaveLength(1);
    expect(fallbacks.validate!({ channel: 'push', transport: 'x' })).toEqual([]);
  });
});

describe('message_receivers', () => {
  const receivers = MESSAGING_DELIVERY_SPECS.find((s) => s.type === 'message_receivers') as CollectionSpec;

  it('is registered, never pruned by a bare --prune, with a write-only secret', () => {
    expect(registeredConfigTypes().map((s) => s.type)).toContain('message_receivers');
    expect(receivers.prune).toBe(false);
    expect(receivers.writeOnly).toEqual(['secret']);
  });

  it('lists the providers with a stored secret and the ones that need none, never a secret or a url', async () => {
    const http = new Http({
      '/v1/message_receivers': {
        data: [
          { provider: 'brevo', secret_set: false, secret_help: null, token: 't', url: 'u' },
          { provider: 'mailgun', secret_set: true, secret_help: 'key' },
          { provider: 'resend', secret_set: false, secret_help: 'whsec' },
        ],
      },
    });
    expect(await receivers.fetchLive(http)).toEqual([
      { key: 'brevo', id: 'brevo', config: { provider: 'brevo' } },
      { key: 'mailgun', id: 'mailgun', config: { provider: 'mailgun' } },
    ]);
  });

  it('sets the secret with PUT, ignores an entry without one, and deletes only a stored secret', async () => {
    const http = new Http();
    await receivers.create(http, { provider: 'mailgun', secret: 'k' });
    await receivers.update!(http, { key: 'mailgun', id: 'mailgun', config: {} }, { provider: 'mailgun', secret: 'k2' });
    await receivers.create(http, { provider: 'brevo' });
    await receivers.remove!(http, { key: 'brevo', id: 'brevo', config: {} });
    await receivers.remove!(http, { key: 'mailgun', id: 'mailgun', config: {} });
    expect(http.calls).toEqual([
      { method: 'PUT', path: '/v1/message_receivers/mailgun', body: { secret: 'k' } },
      { method: 'PUT', path: '/v1/message_receivers/mailgun', body: { secret: 'k2' } },
      { method: 'DELETE', path: '/v1/message_receivers/mailgun' },
    ]);
  });

  it('requires a secret except for providers that need none', () => {
    expect(receivers.validate!({ provider: 'mailgun' })).toHaveLength(1);
    expect(receivers.validate!({ provider: 'mailgun', secret: 'k' })).toEqual([]);
    expect(receivers.validate!({ provider: 'brevo' })).toEqual([]);
    expect(receivers.validate!({ provider: 'brevo', secret: 'k' })).toHaveLength(1);
    expect(receivers.validate!({})).toHaveLength(1);
  });
});
