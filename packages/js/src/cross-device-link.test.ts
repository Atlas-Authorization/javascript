import { describe, expect, it, vi } from 'vitest';
import { confirmCrossDeviceLink, initialFlow, prepareFactor, previewCrossDeviceLink } from './fapi';

const client = (impl: (path: string, body?: unknown) => unknown) =>
  ({
    post: vi.fn(async (path: string, body?: unknown) => ({ ok: true, status: 200, errors: [], data: impl(path, body) })),
    get: vi.fn(async (path: string) => ({ ok: true, status: 200, errors: [], data: impl(path) })),
  }) as never;

describe('cross-device magic link', () => {
  it('asks for a cross-device link and keeps the match code', async () => {
    const c = client(() => ({ poll_secret: 'ps', match_code: '4821' }));
    const next = await prepareFactor(c, { ...initialFlow, attempt: { id: 'sia_1' } as never }, 'email_link', { crossDevice: true });
    expect((c as { post: ReturnType<typeof vi.fn> }).post).toHaveBeenCalledWith('/v1/client/sign_ins/sia_1/prepare_first_factor', { strategy: 'email_link', cross_device: true });
    expect(next).toMatchObject({ pollSecret: 'ps', matchCode: '4821' });
  });
  it('previews and confirms from the second device', async () => {
    const c = client((path) => (path.includes('cross_device=1') ? { requires_confirmation: true, match_code: '4821' } : {}));
    expect(await previewCrossDeviceLink(c, { attempt: 'sia_1', token: 't/1' })).toEqual({ requiresConfirmation: true, matchCode: '4821' });
    expect(await confirmCrossDeviceLink(c, { attempt: 'sia_1', token: 't', matchCode: '4821' })).toBe(true);
    expect((c as { post: ReturnType<typeof vi.fn> }).post).toHaveBeenCalledWith('/v1/client/sign_ins/verify/confirm', { attempt: 'sia_1', token: 't', match_code: '4821' });
  });
});
