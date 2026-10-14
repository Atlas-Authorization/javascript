import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createAtlasClient,
  type EmailProvider,
  type EmailProviderInput,
  type EmailProviderSetup,
  type MessagingProvider,
  type MessagingProviderInput,
  type SmsProvider,
  type SmsProviderInput,
} from './index';

const API_URL = 'https://api.example.test';

function setup(reply: unknown = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as unknown as typeof fetch;
  const c = createAtlasClient({ secretKey: 'sk_test_x', apiUrl: API_URL, fetch: fetchImpl });
  return { c, calls };
}

describe('messaging providers: request shape', () => {
  it('setEmail PUTs the typed body unchanged to /v1/messaging_providers/email', async () => {
    const { c, calls } = setup();
    await c.messaging.setEmail({
      transport: 'smtp',
      from_address: 'Acme <no-reply@acme.test>',
      config: { host: 'smtp.acme.test', port: 465, secure: true, username: 'u', password: 'p' },
    });
    expect(calls[0]).toEqual({
      url: `${API_URL}/v1/messaging_providers/email`,
      method: 'PUT',
      body: {
        transport: 'smtp',
        from_address: 'Acme <no-reply@acme.test>',
        config: { host: 'smtp.acme.test', port: 465, secure: true, username: 'u', password: 'p' },
      },
    });
  });

  it('setSms PUTs to /v1/messaging_providers/sms', async () => {
    const { c, calls } = setup();
    await c.messaging.setSms({
      transport: 'twilio',
      config: { account_sid: 'AC1', auth_token: 't', from: '+15551234567' },
    });
    expect(calls[0]).toMatchObject({
      url: `${API_URL}/v1/messaging_providers/sms`,
      method: 'PUT',
      body: { transport: 'twilio', config: { account_sid: 'AC1', auth_token: 't' } },
    });
  });

  it('an update may omit config (or a stored secret) entirely', async () => {
    const { c, calls } = setup();
    await c.messaging.setEmail({ transport: 'resend', from_address: 'new@acme.test' });
    await c.messaging.setEmail({ transport: 'mailgun', config: { region: 'eu' } });
    expect(calls.map((x) => x.body)).toEqual([
      { transport: 'resend', from_address: 'new@acme.test' },
      { transport: 'mailgun', config: { region: 'eu' } },
    ]);
  });

  it('the deprecated untyped body still compiles and is sent as-is', async () => {
    const { c, calls } = setup();
    const legacy: MessagingProviderInput = { transport: 'resend', config: { api_key: 're_x' } };
    await c.messaging.setEmail(legacy);
    expect(calls[0]?.body).toEqual({ transport: 'resend', config: { api_key: 're_x' } });
  });
});

describe('messaging providers: compile-time contract', () => {
  it('rejects unknown keys, wrong transports and wrong value types', () => {
    const { c } = setup();
    // Each line below must FAIL to compile; `tsc --noEmit` (which covers tests)
    // errors on an unused @ts-expect-error, so a loosened type breaks the build.
    const typeOnly = () => {
      // @ts-expect-error — `apikey` is not a Resend key (typo)
      void c.messaging.setEmail({ transport: 'resend', config: { apikey: 're_x' } });
      // @ts-expect-error — `password` is SMTP's key, not Resend's
      void c.messaging.setEmail({ transport: 'resend', config: { password: 'p' } });
      // @ts-expect-error — `twilio` is an SMS transport, not email
      void c.messaging.setEmail({ transport: 'twilio', config: { account_sid: 'AC1' } });
      // @ts-expect-error — `resend` is an email transport, not SMS
      void c.messaging.setSms({ transport: 'resend', config: { api_key: 're_x' } });
      // @ts-expect-error — port is a number
      void c.messaging.setEmail({ transport: 'smtp', config: { host: 'h', port: [587] } });
      // @ts-expect-error — mailgun region is 'us' | 'eu'
      void c.messaging.setEmail({ transport: 'mailgun', config: { region: 'ap' } });
      // @ts-expect-error — unknown transport literal
      void c.messaging.setEmail({ transport: 'sendgrid', config: {} });
      // @ts-expect-error — `whatsapp_from` is Twilio-only
      void c.messaging.setSms({ transport: 'vonage', config: { whatsapp_from: '+1' } });
    };
    void typeOnly;

    // First-setup shape requires every required key.
    // @ts-expect-error — Mailgun first setup needs `domain`
    const missing: EmailProviderSetup = { transport: 'mailgun', config: { api_key: 'k' } };
    void missing;
    const ok = { transport: 'mailgun', config: { api_key: 'k', domain: 'mg.acme.test' } } satisfies EmailProviderSetup;
    expectTypeOf(ok).toMatchTypeOf<EmailProviderInput>();

    expectTypeOf<{ transport: 'aws_sns'; config: { region: string } }>().toMatchTypeOf<SmsProviderInput>();
  });

  it('responses never expose secret keys and narrow by transport', () => {
    const { c } = setup();
    const typeOnly = () => {
      expectTypeOf(c.messaging.setEmail({ transport: 'resend' })).resolves.toEqualTypeOf<EmailProvider>();
      expectTypeOf(c.messaging.setSms({ transport: 'telnyx' })).resolves.toEqualTypeOf<SmsProvider>();
    };
    void typeOnly;

    const read = (p: MessagingProvider) => {
      if (p.transport === 'resend') {
        expectTypeOf(p.secrets_set).toEqualTypeOf<{ api_key: boolean }>();
        // @ts-expect-error — the secret never comes back in `config`
        void p.config.api_key;
      }
      if (p.transport === 'twilio') {
        expectTypeOf(p.config.account_sid).toEqualTypeOf<string | undefined>();
        expectTypeOf(p.secrets_set).toEqualTypeOf<{ auth_token: boolean }>();
        // @ts-expect-error — write-only
        void p.config.auth_token;
      }
      if (p.transport === 'ses') {
        // @ts-expect-error — SES access key id is write-only too
        void p.config.access_key_id;
      }
    };
    void read;
  });
});
