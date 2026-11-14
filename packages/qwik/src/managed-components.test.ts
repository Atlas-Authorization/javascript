import { describe, expect, it } from 'vitest';
import * as api from '@atlasauth/js';
import { meClients } from './managed';

describe('API keys, billing and device authorization', () => {
  // The component$ exports need Qwik's optimizer, which this plain-vitest suite does not run; the labels are shared.
  it('shares the labels', () => {
    expect(api.API_KEYS_LABELS.title).toBe('API keys');
    expect(api.BILLING_LABELS.subscribe).toBe('Subscribe');
    expect(api.DEVICE_AUTH_LABELS.approve).toBe('Allow');
  });

  it('builds the client and step-up options from the store', () => {
    const { client, reauth } = meClients({ publishableKey: 'pk_test_x', frontendApi: 'https://fapi.example' });
    expect(client.publishableKey).toBe('pk_test_x');
    expect(reauth).toEqual({ api: 'https://fapi.example', publishableKey: 'pk_test_x' });
  });
});
