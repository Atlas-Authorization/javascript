import { describe, expect, it, vi } from 'vitest';
import { activateOrgOrStepUp, isOrgStepUpError, orgStepUpErrorFromResponse, orgStepUpOptions, runOrgStepUp } from './org-step-up';

const refusal = (allowed?: string[]) =>
  new Response(
    JSON.stringify({
      errors: [
        { code: 'STEP_UP_REQUIRED', reason: 'org_mfa_step_up_required', message: 'step up', meta: { allowed_factors: allowed } },
      ],
    }),
    { status: 403 },
  );

describe('org step-up', () => {
  it('reads the reason and allowed factors; ignores other refusals', async () => {
    const err = await orgStepUpErrorFromResponse(refusal(['passkey']));
    expect(isOrgStepUpError(err)).toBe(true);
    expect(err?.allowedFactors).toEqual(['passkey']);
    expect(await orgStepUpErrorFromResponse(new Response('{"errors":[{"code":"X"}]}', { status: 403 }))).toBeNull();
    expect(await orgStepUpErrorFromResponse(new Response('nope', { status: 500 }))).toBeNull();
  });

  it('hides the code field when totp is excluded and passkey when not allowed', async () => {
    const onlyPasskey = (await orgStepUpErrorFromResponse(refusal(['passkey'])))!;
    expect(orgStepUpOptions(onlyPasskey, {})).toEqual({ totp: false, passkey: true });
    const onlyTotp = (await orgStepUpErrorFromResponse(refusal(['totp'])))!;
    expect(orgStepUpOptions(onlyTotp, {})).toEqual({ totp: true, passkey: false });
    const any = (await orgStepUpErrorFromResponse(refusal()))!;
    expect(orgStepUpOptions(any, {})).toEqual({ totp: true, passkey: true });
  });

  it('activateOrgOrStepUp resolves the step-up error and rethrows others', async () => {
    const err = (await orgStepUpErrorFromResponse(refusal()))!;
    expect(await activateOrgOrStepUp(async () => { throw err; }, 'o')).toBe(err);
    expect(await activateOrgOrStepUp(async () => {}, 'o')).toBeNull();
    await expect(activateOrgOrStepUp(async () => { throw new Error('boom'); }, 'o')).rejects.toThrow('boom');
  });

  it('runOrgStepUp by code posts totp and reports a refusal message', async () => {
    const post = vi.fn().mockResolvedValueOnce({ ok: true, errors: [] }).mockResolvedValueOnce({ ok: false, errors: [{ message: 'bad code' }] });
    const client = { post } as never;
    expect(await runOrgStepUp(client, { code: '123456' })).toEqual({ ok: true });
    expect(post).toHaveBeenCalledWith('/v1/client/me/step_up', { strategy: 'totp', code: '123456' });
    expect(await runOrgStepUp(client, { code: '000000' })).toEqual({ ok: false, message: 'bad code' });
  });
});
