import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { botIdAttestationHandler, createBotIdAttestation, BOTID_ATTESTATION_PREFIX } from './botid';

const SECRET = 'x'.repeat(40);

function decode(token: string) {
  const [payload, sig] = token.slice(BOTID_ATTESTATION_PREFIX.length).split('.');
  return { payload: JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')), payloadPart: payload!, sig: sig! };
}

describe('createBotIdAttestation', () => {
  it('signs the verdict with the shared secret over the prefixed payload', () => {
    const token = createBotIdAttestation({ secret: SECRET, verdict: { isBot: false }, now: 1_700_000_000_000 });
    expect(token.startsWith(BOTID_ATTESTATION_PREFIX)).toBe(true);
    const { payload, payloadPart, sig } = decode(token);
    expect(payload).toMatchObject({ v: 1, is_bot: false, verified_bot: false, iat: 1_700_000_000, exp: 1_700_000_060 });
    expect(typeof payload.jti).toBe('string');
    expect(payload.jti.length).toBeGreaterThanOrEqual(16);
    const expected = createHmac('sha256', SECRET).update(BOTID_ATTESTATION_PREFIX + payloadPart).digest('base64url');
    expect(sig).toBe(expected);
  });

  it('records a bot verdict as is_bot (Atlas refuses it)', () => {
    expect(decode(createBotIdAttestation({ secret: SECRET, verdict: { isBot: true, isVerifiedBot: true } })).payload).toMatchObject({
      is_bot: true,
      verified_bot: true,
    });
  });

  it('clamps the lifetime to five minutes and mints a fresh jti each time', () => {
    const a = decode(createBotIdAttestation({ secret: SECRET, verdict: { isBot: false }, ttlSeconds: 9999, now: 0 })).payload;
    const b = decode(createBotIdAttestation({ secret: SECRET, verdict: { isBot: false }, now: 0 })).payload;
    expect(a.exp - a.iat).toBe(300);
    expect(a.jti).not.toBe(b.jti);
  });

  it('refuses a short secret', () => {
    expect(() => createBotIdAttestation({ secret: 'short', verdict: { isBot: false } })).toThrow(/at least 32/);
  });
});

describe('botIdAttestationHandler', () => {
  it('answers { token } with no-store', async () => {
    const handler = botIdAttestationHandler({ secret: SECRET, checkBotId: async () => ({ isBot: false }) });
    const res = await handler();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { token: string };
    expect(decode(body.token).payload.is_bot).toBe(false);
  });

  it('answers 503 when BotID itself fails, so no unchecked token is handed out', async () => {
    const handler = botIdAttestationHandler({
      secret: SECRET,
      checkBotId: async () => {
        throw new Error('down');
      },
    });
    const res = await handler();
    expect(res.status).toBe(503);
  });
});
