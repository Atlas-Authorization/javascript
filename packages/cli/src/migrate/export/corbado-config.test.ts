import { describe, expect, it } from 'vitest';
import { fetchCorbadoConfig, translateCorbadoConfig } from './corbado-config';
import { fakeVendor, noSleep } from './fake-vendor.test-helper';
import { VendorHttp } from './vendor-http';

const ORIGIN = 'https://backendapi.cloud.corbado.io';

function http(routes: Record<string, unknown>) {
  const fake = fakeVendor(ORIGIN, routes);
  return { fake, http: new VendorHttp({ vendor: 'Corbado', baseUrl: ORIGIN, fetchImpl: fake.fetchImpl, sleep: noSleep }) };
}

describe('Corbado config', () => {
  it('counts identifiers per type with the documented filter, tolerating a missing endpoint', async () => {
    const { fake, http: h } = http({
      'GET /v2/identifiers': ({ url }: { url: URL }) => {
        const f = url.searchParams.get('filter[]');
        if (f === 'identifierType:eq:email') return { identifiers: [], paging: { page: 1, totalPages: 9, totalItems: 42 } };
        if (f === 'identifierType:eq:username') return { identifiers: [], paging: { page: 1, totalPages: 0, totalItems: 0 } };
        return { status: 404, body: { message: 'nope' } };
      },
    });
    const snap = await fetchCorbadoConfig(h, 'pro-1', 'acme.example');
    expect(snap).toEqual({ projectId: 'pro-1', rpId: 'acme.example', identifiers: { email: 42, phone: null, username: 0 } });
    expect(fake.calls[0]!.url).toContain('pageSize=1');
  });

  it('turns on passkeys plus the methods the users actually have, and reports the rest', () => {
    const r = translateCorbadoConfig({ projectId: 'pro-1', rpId: 'acme.example', identifiers: { email: 42, phone: 3, username: 0 } });
    expect(r.documents.instance).toEqual({
      auth_config: { strategies: { passkey: true, emailCode: true, phoneCode: true }, accountUx: { passkeySignUp: { enabled: true } } },
    });
    expect(r.bridge).toEqual({ preset: 'corbado', vars: { project_id: 'pro-1' } });
    expect(r.origin).toBe('Corbado project pro-1');
    expect(r.report.find((e) => e.setting === 'relying party')!.status).toBe('differs');
    expect(r.report.filter((e) => e.status === 'manual').length).toBeGreaterThanOrEqual(4);
  });

  it('asks for the relying-party id and the identifiers when Corbado returned neither', () => {
    const r = translateCorbadoConfig({ projectId: 'pro-2', identifiers: { email: null, phone: null, username: null } });
    expect(r.report.find((e) => e.setting === 'relying party')!.status).toBe('manual');
    expect(r.report.find((e) => e.setting === 'login identifiers')!.status).toBe('manual');
    expect((r.documents.instance as { auth_config: { strategies: Record<string, boolean> } }).auth_config.strategies).toEqual({ passkey: true });
  });
});
