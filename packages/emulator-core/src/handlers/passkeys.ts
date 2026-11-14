/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteContext, RouteDef } from '../engine';
import { bytesToB64url, sha256 } from '../crypto-util';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { randomToken } from '../store';
import { VirtualAuthenticator, cborDecode, derToRaw } from '../webauthn-virtual';
import { listReply, need } from './util';

/**
 * The Passkey API (`/v1/passkey_api/*`): server-to-server WebAuthn ceremonies for a customer-owned user store, verified
 * for real (challenge, origin, RP id hash, user presence, ES256 signature, signature counter). Pair it with the virtual
 * authenticator (`createVirtualAuthenticator`, or the `/__emulator/webauthn/*` routes) to run a whole passkey
 * round trip with no browser.
 */
const CHALLENGE_TTL_MS = 5 * 60_000;
const dec = new TextDecoder();
const unb64url = (s: string): Uint8Array => {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
};

interface PasskeyState {
  registrations: Map<string, { userId: string; expiresAt: number }>; // challenge
  logins: Map<string, { challenge: string; userId: string | null; expiresAt: number }>; // handle
  authenticators: Map<string, VirtualAuthenticator>;
  registeredCount: number;
  loginCount: number;
}
const states = new WeakMap<Engine, PasskeyState>();
const st = (e: Engine): PasskeyState => {
  let s = states.get(e);
  if (!s) states.set(e, (s = { registrations: new Map(), logins: new Map(), authenticators: new Map(), registeredCount: 0, loginCount: 0 }));
  return s;
};
export const resetPasskeys = (e: Engine): void => void states.delete(e);

const rpIdOf = (e: Engine): string => {
  try {
    return new URL(e.issuer).hostname;
  } catch {
    return 'localhost';
  }
};
const text = (c: RouteContext, k: string, max = 4096, required = true): string | undefined => {
  const v = c.body[k];
  if (v === undefined || v === null) {
    if (required) throw new EmulatorError('VALIDATION_FAILED', `${k} is required.`, k);
    return undefined;
  }
  if (typeof v !== 'string' || !v.length || v.length > max) throw new EmulatorError('VALIDATION_FAILED', `${k} must be a string of 1 to ${max} characters.`, k);
  return v;
};

const present = (p: Obj): Obj => ({
  object: 'external_passkey',
  id: p.id,
  user_id: p.user_id,
  credential_id: p.credential_id,
  name: p.name ?? null,
  aaguid: p.aaguid,
  backed_up: p.backed_up === true,
  transports: p.transports ?? [],
  last_used_at: p.last_used_at ?? null,
  created_at: p.created_at,
});

/** Parse `clientDataJSON` and check the ceremony type and challenge; origin must be https (or localhost). */
function checkClientData(b64: string, type: string, challenge: string): void {
  let cd: any;
  try {
    cd = JSON.parse(dec.decode(unb64url(b64)));
  } catch {
    throw new EmulatorError('VALIDATION_FAILED', 'client_data_json is not valid.', 'client_data_json');
  }
  if (cd.type !== type) throw new EmulatorError('VALIDATION_FAILED', `clientDataJSON.type must be ${type}.`, 'client_data_json');
  if (cd.challenge !== challenge) throw new EmulatorError('VALIDATION_FAILED', 'The challenge does not match.', 'challenge');
  let origin: URL;
  try {
    origin = new URL(String(cd.origin));
  } catch {
    throw new EmulatorError('VALIDATION_FAILED', 'clientDataJSON.origin is not a URL.', 'client_data_json');
  }
  if (origin.protocol !== 'https:' && origin.hostname !== 'localhost' && origin.hostname !== '127.0.0.1') throw new EmulatorError('VALIDATION_FAILED', 'The origin is not allowed.', 'client_data_json');
}

export function passkeyHandlers(): RouteDef[] {
  const fresh = (e: Engine) => {
    const now = e.clock.now();
    for (const [k, v] of st(e).registrations) if (v.expiresAt <= now) st(e).registrations.delete(k);
    for (const [k, v] of st(e).logins) if (v.expiresAt <= now) st(e).logins.delete(k);
  };
  const auth = (id: string, e: Engine): VirtualAuthenticator => {
    const a = st(e).authenticators.get(id);
    if (!a) throw notFound('Authenticator');
    return a;
  };

  return [
    {
      method: 'POST',
      pattern: '/v1/passkey_api/registration/init',
      handler: (c) => {
        const e = c.engine;
        fresh(e);
        const userId = text(c, 'user_id', 255)!;
        const challenge = randomToken(32);
        st(e).registrations.set(challenge, { userId, expiresAt: e.clock.now() + CHALLENGE_TTL_MS });
        const existing = e.db.passkeys.filter((p) => p.user_id === userId);
        const options = {
          rp: { id: rpIdOf(e), name: 'Atlas emulator' },
          user: { id: bytesToB64url(new TextEncoder().encode(userId)), name: text(c, 'username', 255, false) ?? userId, displayName: text(c, 'display_name', 255, false) ?? text(c, 'username', 255, false) ?? userId },
          challenge,
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          timeout: 300_000,
          attestation: 'none',
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
          excludeCredentials: existing.map((p) => ({ type: 'public-key', id: p.credential_id })),
        };
        return { status: 201, body: { object: 'passkey_registration_options', options } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/passkey_api/registration/finalize',
      handler: async (c) => {
        const e = c.engine;
        fresh(e);
        const userId = text(c, 'user_id', 255)!;
        const challenge = text(c, 'challenge')!;
        const pending = st(e).registrations.get(challenge);
        if (!pending || pending.userId !== userId) throw new EmulatorError('VALIDATION_FAILED', 'The registration challenge is unknown or expired.', 'challenge');
        checkClientData(text(c, 'client_data_json', 65536)!, 'webauthn.create', challenge);
        let authData: Uint8Array;
        try {
          const att = cborDecode(unb64url(text(c, 'attestation_object', 65536)!)).value as Map<string, any>;
          authData = att.get('authData');
        } catch {
          throw new EmulatorError('VALIDATION_FAILED', 'attestation_object is not valid CBOR.', 'attestation_object');
        }
        if (!(authData instanceof Uint8Array) || authData.length < 55) throw new EmulatorError('VALIDATION_FAILED', 'attestation_object has no authenticator data.', 'attestation_object');
        const expectHash = await sha256(rpIdOf(e));
        if (bytesToB64url(authData.slice(0, 32)) !== bytesToB64url(expectHash)) throw new EmulatorError('VALIDATION_FAILED', 'The RP id hash does not match.', 'attestation_object');
        const flags = authData[32]!;
        if (!(flags & 0x01)) throw new EmulatorError('VALIDATION_FAILED', 'User presence is required.', 'attestation_object');
        if (!(flags & 0x40)) throw new EmulatorError('VALIDATION_FAILED', 'No attested credential data.', 'attestation_object');
        const credLen = (authData[53]! << 8) | authData[54]!;
        const credentialId = bytesToB64url(authData.slice(55, 55 + credLen));
        const cose = cborDecode(authData, 55 + credLen).value as Map<number, any>;
        if (cose.get(3) !== -7 || cose.get(1) !== 2) throw new EmulatorError('VALIDATION_FAILED', 'Only ES256 credentials are supported.', 'attestation_object');
        if (e.db.passkeys.find((p) => p.credential_id === credentialId)) throw new EmulatorError('IDENTIFIER_EXISTS', 'That credential is already registered.', 'attestation_object');
        st(e).registrations.delete(challenge);
        const now = e.clock.now();
        const row = e.db.passkeys.insert({
          user_id: userId,
          credential_id: credentialId,
          public_jwk: { kty: 'EC', crv: 'P-256', x: bytesToB64url(cose.get(-2)), y: bytesToB64url(cose.get(-3)) },
          name: text(c, 'name', 100, false) ?? null,
          aaguid: [...authData.slice(37, 53)].map((b) => b.toString(16).padStart(2, '0')).join(''),
          backed_up: !!(flags & 0x10),
          transports: Array.isArray(c.body.transports) ? c.body.transports : [],
          sign_count: 0,
          last_used_at: null,
          created_at: now,
        });
        st(e).registeredCount++;
        e.webhooks.emit('passkey.registered', present(row));
        return { status: 201, body: present(row) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/passkey_api/login/init',
      handler: (c) => {
        const e = c.engine;
        fresh(e);
        const userId = text(c, 'user_id', 255, false) ?? null;
        const handle = `pkh_${randomToken(16)}`;
        const challenge = randomToken(32);
        st(e).logins.set(handle, { challenge, userId, expiresAt: e.clock.now() + CHALLENGE_TTL_MS });
        const options = {
          challenge,
          rpId: rpIdOf(e),
          timeout: 300_000,
          userVerification: 'preferred',
          allowCredentials: userId ? e.db.passkeys.filter((p) => p.user_id === userId).map((p) => ({ type: 'public-key', id: p.credential_id })) : [],
        };
        return { status: 201, body: { object: 'passkey_login_options', handle, options } };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/passkey_api/login/finalize',
      handler: async (c) => {
        const e = c.engine;
        fresh(e);
        const handle = text(c, 'handle', 255)!;
        const pending = st(e).logins.get(handle);
        if (!pending || pending.challenge !== text(c, 'challenge')) throw new EmulatorError('VALIDATION_FAILED', 'The login challenge is unknown or expired.', 'challenge');
        const credId = text(c, 'credential_id')!;
        const row = e.db.passkeys.find((p) => p.credential_id === credId);
        const wantUser = text(c, 'user_id', 255, false) ?? pending.userId;
        if (!row || (wantUser && row.user_id !== wantUser)) throw new EmulatorError('VALIDATION_FAILED', 'That credential is not registered for this user.', 'credential_id');
        checkClientData(text(c, 'client_data_json', 65536)!, 'webauthn.get', pending.challenge);
        const authData = unb64url(text(c, 'authenticator_data', 65536)!);
        if (authData.length < 37) throw new EmulatorError('VALIDATION_FAILED', 'authenticator_data is too short.', 'authenticator_data');
        if (bytesToB64url(authData.slice(0, 32)) !== bytesToB64url(await sha256(rpIdOf(e)))) throw new EmulatorError('VALIDATION_FAILED', 'The RP id hash does not match.', 'authenticator_data');
        if (!(authData[32]! & 0x01)) throw new EmulatorError('VALIDATION_FAILED', 'User presence is required.', 'authenticator_data');
        const clientHash = await sha256(unb64url(text(c, 'client_data_json', 65536)!));
        const signed = new Uint8Array(authData.length + clientHash.length);
        signed.set(authData);
        signed.set(clientHash, authData.length);
        const key = await crypto.subtle.importKey('jwk', row.public_jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        let ok = false;
        try {
          ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(unb64url(text(c, 'signature', 65536)!)) as BufferSource, signed as BufferSource);
        } catch {
          ok = false;
        }
        if (!ok) throw new EmulatorError('VALIDATION_FAILED', 'The signature does not verify against the registered key.', 'signature');
        const counter = new DataView(authData.buffer, authData.byteOffset + 33, 4).getUint32(0);
        // A non-zero counter that does not advance means a cloned authenticator: still verified, but flagged.
        const cloned = (counter !== 0 || row.sign_count !== 0) && counter <= row.sign_count;
        row.sign_count = Math.max(row.sign_count, counter);
        row.last_used_at = e.clock.now();
        st(e).logins.delete(handle);
        st(e).loginCount++;
        return { body: { object: 'passkey_login_result', verified: true, user_id: row.user_id, credential_id: row.credential_id, passkey_id: row.id, user_verified: !!(authData[32]! & 0x04), cloned_warning: cloned } };
      },
    },
    { method: 'GET', pattern: '/v1/passkey_api/users/:userId/passkeys', handler: (c) => listReply(c, c.engine.db.passkeys.filter((p) => p.user_id === c.params.userId), present) },
    {
      method: 'DELETE',
      pattern: '/v1/passkey_api/users/:userId/passkeys/:id',
      handler: (c) => {
        const p = c.engine.db.passkeys.get(c.params.id);
        if (!p || p.user_id !== c.params.userId) throw notFound('Passkey');
        c.engine.db.passkeys.delete(p.id);
        c.engine.webhooks.emit('passkey.removed', present(p));
        return { body: { object: 'external_passkey', id: p.id, deleted: true } };
      },
    },
    { method: 'GET', pattern: '/v1/passkey_api/usage', handler: (c) => ({ body: { object: 'passkey_api_usage', passkeys: c.engine.db.passkeys.size } }) },
    // ── the virtual authenticator over HTTP, for tests that are not JavaScript ──
    {
      method: 'POST',
      pattern: '/__emulator/webauthn/authenticators',
      public: true,
      handler: (c) => {
        const id = `va_${randomToken(8)}`;
        st(c.engine).authenticators.set(id, new VirtualAuthenticator({ origin: typeof c.body.origin === 'string' ? c.body.origin : c.engine.issuer, userVerified: c.body.user_verified !== false }));
        return { status: 201, body: { id } };
      },
    },
    {
      method: 'POST',
      pattern: '/__emulator/webauthn/authenticators/:id/create',
      public: true,
      handler: async (c) => ({ body: await auth(c.params.id!, c.engine).create(need(c.body, 'options')) }),
    },
    {
      method: 'POST',
      pattern: '/__emulator/webauthn/authenticators/:id/get',
      public: true,
      handler: async (c) => ({ body: await auth(c.params.id!, c.engine).get(need(c.body, 'options')) }),
    },
    {
      method: 'POST',
      pattern: '/__emulator/webauthn/authenticators/:id/freeze_counter',
      public: true,
      handler: (c) => ((auth(c.params.id!, c.engine).frozenCounter = c.body.frozen !== false), { body: { ok: true } }),
    },
  ];
}
