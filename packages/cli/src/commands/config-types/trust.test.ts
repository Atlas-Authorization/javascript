import { describe, expect, it } from 'vitest';
import type { ConfigHttp } from '../../config-http';
import type { SingletonSpec } from '../config';
import { registeredConfigTypes } from './index';
import { TRUST_CONFIG_TYPES } from './trust';

class Http implements ConfigHttp {
  calls: Array<{ method: string; path: string; body?: unknown }> = [];
  constructor(private doc: unknown = {}) {}
  async get<T>(path: string): Promise<T> {
    this.calls.push({ method: 'GET', path });
    return this.doc as T;
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

const schedule = TRUST_CONFIG_TYPES.find((s) => s.type === 'signing_key_schedule') as SingletonSpec;
const chain = TRUST_CONFIG_TYPES.find((s) => s.type === 'audit_chain') as SingletonSpec;

describe('signing_key_schedule config type', () => {
  it('is registered', () => {
    expect(registeredConfigTypes().map((s) => s.type)).toEqual(expect.arrayContaining(['signing_key_schedule', 'audit_chain']));
  });

  it('reads no schedule as nothing live, and a schedule as its file keys only', async () => {
    expect(await schedule.fetchLive(new Http({ object: 'signing_key_schedule', enabled: false, interval_days: null }))).toBeNull();
    const live = await schedule.fetchLive(
      new Http({ object: 'signing_key_schedule', enabled: true, interval_days: 30, alg: 'ES384', grace_period_seconds: null, prepublish_hours: 24, effective_grace_seconds: 90000, next_rotation_at: 5 }),
    );
    expect(live).toEqual({ enabled: true, interval_days: 30, alg: 'ES384', grace_period_seconds: null, prepublish_hours: 24 });
  });

  it('applies with a PUT of the file keys only', async () => {
    const http = new Http();
    await schedule.apply(http, { interval_days: 14, alg: 'EdDSA', effective_grace_seconds: 1 }, { forceHook: false });
    expect(http.calls).toEqual([{ method: 'PUT', path: '/v1/instance/signing_key_schedule', body: { interval_days: 14, alg: 'EdDSA' } }]);
  });
});

describe('audit_chain config type', () => {
  it('reads an off chain as nothing live and an on chain as enabled', async () => {
    expect(await chain.fetchLive(new Http({ enabled: false }))).toBeNull();
    expect(await chain.fetchLive(new Http({ enabled: true, checkpoint_interval_seconds: 600, head_seq: 4 }))).toEqual({ enabled: true, checkpoint_interval_seconds: 600 });
  });

  it('only ever turns the chain on', async () => {
    const http = new Http();
    await chain.apply(http, { enabled: false, checkpoint_interval_seconds: 900 }, { forceHook: false });
    expect(http.calls).toEqual([{ method: 'PUT', path: '/v1/audit/chain', body: { enabled: true, checkpoint_interval_seconds: 900 } }]);
  });
});
