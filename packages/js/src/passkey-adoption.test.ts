import { describe, expect, it, vi } from 'vitest';
import { dismissPasskeyPrompt, finishPasskeyRecovery, passkeyPromptDue, reportPasskeyPromptEvent, sendPasskeySignals, signalUnknownPasskey, startPasskeyRecovery } from './passkey';
import type { FapiClient } from './fapi';

const input = { enabled: true, rp_id: 'x.test', user_id: 'dQ', name: 'ada', display_name: 'Ada', credential_ids: ['c1'] };

describe('passkey Signal API', () => {
  it('sends nothing while disabled or unsupported', async () => {
    expect(await sendPasskeySignals({ ...input, enabled: false }, { signalAllAcceptedCredentials: vi.fn() })).toEqual([]);
    expect(await sendPasskeySignals(input, {})).toEqual([]);
  });

  it('sends accepted ids and user details, swallowing rejections', async () => {
    const all = vi.fn().mockResolvedValue(undefined);
    const details = vi.fn().mockRejectedValue(new Error('stale'));
    const sent = await sendPasskeySignals(input, { signalAllAcceptedCredentials: all, signalCurrentUserDetails: details });
    expect(all).toHaveBeenCalledWith({ rpId: 'x.test', userId: 'dQ', allAcceptedCredentialIds: ['c1'] });
    expect(sent).toEqual(['signalAllAcceptedCredentials']);
  });

  it('reports an unknown credential only when supported', async () => {
    expect(await signalUnknownPasskey('x.test', 'c9', {})).toBe(false);
    const fn = vi.fn().mockResolvedValue(undefined);
    expect(await signalUnknownPasskey('x.test', 'c9', { signalUnknownCredential: fn })).toBe(true);
    expect(fn).toHaveBeenCalledWith({ rpId: 'x.test', credentialId: 'c9' });
  });
});

describe('passkey prompt cooldown', () => {
  const decision = { eligible: true, variant: 'v', cooldown_days: 2 };
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
  };

  it('hides the nudge for the cooldown after a dismissal', () => {
    const store = mem();
    expect(passkeyPromptDue(decision, store, 1000)).toBe(true);
    dismissPasskeyPrompt(store, 1000);
    expect(passkeyPromptDue(decision, store, 1000 + 86_400_000)).toBe(false);
    expect(passkeyPromptDue(decision, store, 1000 + 3 * 86_400_000)).toBe(true);
    expect(passkeyPromptDue({ ...decision, eligible: false }, mem(), 0)).toBe(false);
  });
});

describe('prompt events and recovery', () => {
  const fake = (responses: Record<string, { ok: boolean; data?: unknown }>) => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      post: async (path: string, body: unknown) => {
        calls.push([path, body]);
        const r = responses[path] ?? { ok: true };
        return { ok: r.ok, status: r.ok ? 200 : 400, data: r.data ?? null, errors: [] };
      },
    } as unknown as FapiClient;
    return { client, calls };
  };

  it('reports a prompt event and never throws', async () => {
    const { client, calls } = fake({});
    expect(await reportPasskeyPromptEvent(client, 'shown', 'mobile')).toBe(true);
    expect(calls[0]).toEqual(['/v1/client/me/passkeys/prompt/events', { event: 'shown', device_class: 'mobile' }]);
    const broken = { post: async () => { throw new Error('offline'); } } as unknown as FapiClient;
    expect(await reportPasskeyPromptEvent(broken, 'dismissed')).toBe(false);
  });

  it('starts recovery with a sign-in attempt then a code, and finishes with the code', async () => {
    const { client, calls } = fake({ '/v1/client/sign_ins': { ok: true, data: { id: 'sia_1' } } });
    const started = await startPasskeyRecovery(client, 'ada@example.com');
    expect(started.data).toEqual({ id: 'sia_1' });
    expect(calls[1]).toEqual(['/v1/client/sign_ins/sia_1/prepare_first_factor', { strategy: 'email_code' }]);
    await finishPasskeyRecovery(client, 'sia_1', '123456', 'phone');
    expect(calls[2]).toEqual(['/v1/client/sign_ins/sia_1/attempt_first_factor', { strategy: 'phone_code', code: '123456' }]);
  });

  it('stops when the sign-in cannot start', async () => {
    const { client, calls } = fake({ '/v1/client/sign_ins': { ok: false } });
    expect((await startPasskeyRecovery(client, 'x')).ok).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
