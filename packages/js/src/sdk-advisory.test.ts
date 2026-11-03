import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FapiClient } from './fapi';
import {
  ATLAS_JS_SDK,
  parseSdkAdvisory,
  reportSdkAdvisory,
  resetSdkAdvisoryLog,
  sdkHeaderValue,
} from './sdk-advisory';
import { ATLAS_JS_VERSION } from './version';

afterEach(() => resetSdkAdvisoryLog());

const withHeader = (value: string | null) => ({ headers: new Headers(value ? { 'atlas-sdk-advisory': value } : {}) });

describe('version constant', () => {
  it('matches package.json (bump both together)', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
    expect(ATLAS_JS_VERSION).toBe(pkg.version);
  });
});

describe('Atlas-SDK-Advisory', () => {
  it('parses one or several advisories', () => {
    expect(parseSdkAdvisory('upgrade; min=0.8.1; reason=email_code_sign_in, upgrade; min=0.9.1; reason=use_client_directive')).toEqual([
      { action: 'upgrade', min: '0.8.1', reason: 'email_code_sign_in' },
      { action: 'upgrade', min: '0.9.1', reason: 'use_client_directive' },
    ]);
    expect(parseSdkAdvisory(null)).toEqual([]);
    expect(parseSdkAdvisory('  ')).toEqual([]);
  });

  it('warns once per advisory per page load', () => {
    const warn = vi.fn();
    const sdk = { name: '@atlasauth/react', version: '0.8.0' };
    const res = withHeader('upgrade; min=0.8.1; reason=email_code_sign_in');
    expect(reportSdkAdvisory(res, sdk, warn)).toHaveLength(1);
    reportSdkAdvisory(res, sdk, warn);
    reportSdkAdvisory(res, sdk, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('@atlasauth/react 0.8.0');
    expect(warn.mock.calls[0]![0]).toContain('0.8.1');
    // A second advisory still gets its own (single) warning.
    reportSdkAdvisory(withHeader('upgrade; min=0.9.1; reason=use_client_directive'), sdk, warn);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('is silent with no header, and never throws on an odd response', () => {
    const warn = vi.fn();
    reportSdkAdvisory(withHeader(null), ATLAS_JS_SDK, warn);
    reportSdkAdvisory(null, ATLAS_JS_SDK, warn);
    reportSdkAdvisory({} as never, ATLAS_JS_SDK, warn);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('FapiClient names the SDK', () => {
  it('sends X-Atlas-SDK (its own package by default, or the framework one) and logs an advisory once', async () => {
    const seen: Record<string, string>[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      return new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json', 'atlas-sdk-advisory': 'upgrade; min=9.9.9; reason=test_reason' },
      });
    }) as unknown as typeof fetch;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await new FapiClient({ publishableKey: 'pk_test_x', fetchImpl }).get('/v1/client');
      const react = new FapiClient({ publishableKey: 'pk_test_x', fetchImpl, sdk: { name: '@atlasauth/react', version: '0.10.0' } });
      await react.get('/v1/client');
      await react.get('/v1/client');
      expect(seen[0]!['x-atlas-sdk']).toBe(sdkHeaderValue(ATLAS_JS_SDK));
      expect(seen[1]!['x-atlas-sdk']).toBe('@atlasauth/react/0.10.0');
      // One warning for @atlasauth/js, one for @atlasauth/react: not one per request.
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});
