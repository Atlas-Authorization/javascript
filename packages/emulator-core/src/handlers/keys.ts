/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { recordCaller } from './round2';
import { bump, listReply, need } from './util';
import { endActor } from './revocations';
import { claimJti, generateKeyPair, narrowScopes, parseHolderPublicKey, peekKid, verifyAssertion } from './key-pair';

const endReason = (k: Obj): string | null => (!k.revoked_at ? null : (k.revoked_reason ?? (k.revoked_by?.type === 'user' ? 'revoked_by_admin' : 'revoked_by_api')));

const diesWithOf = (v: unknown): 'sign_out_everywhere' | null | undefined => {
  if (v === undefined || v === '') return undefined;
  if (v === null) return null;
  if (v !== 'sign_out_everywhere') throw new EmulatorError('VALIDATION_FAILED', 'dies_with must be "sign_out_everywhere" or null.', 'dies_with');
  return v;
};

/** `metadata` is the same object as `claims`: fold it in, and refuse both at once. */
const foldMetadata = (body: Obj): void => {
  if (body.metadata === undefined) return;
  if (body.claims !== undefined) throw new EmulatorError('VALIDATION_FAILED', 'Send `metadata` or `claims`, not both: they are the same object.', 'metadata');
  body.claims = body.metadata;
  delete body.metadata;
};

export function presentKey(e: Engine, k: Obj): Obj {
  return e.shape('ApiKey', {
    object: 'api_key',
    id: k.id,
    subject_type: k.subject_type,
    subject_id: k.subject_id,
    name: k.name ?? null,
    prefix: k.prefix,
    claims: k.claims ?? {},
    metadata: k.claims ?? {},
    dies_with: k.dies_with ?? null,
    end_reason: endReason(k),
    ended_at: k.revoked_at ?? null,
    revoked_by: endActor(k.revoked_by?.type, k.revoked_by?.id),
    revoked_reason: k.revoked_reason ?? null,
    credential: k.credential ?? 'secret',
    audience: k.audience ?? null,
    key_id: k.id,
    ...(k.credential === 'key_pair' ? { public_key: k.public_key, public_key_jkt: k.public_key_jkt } : {}),
    scopes: k.scopes ?? null,
    constraints: k.constraints ?? null,
    enabled: k.enabled !== false,
    rate_limit: k.rate_limit ?? null,
    remaining: k.remaining ?? null,
    last_used_at: k.last_used_at ?? null,
    expires_at: k.expires_at ?? null,
    revoked_at: k.revoked_at ?? null,
    created_at: k.created_at,
  });
}

const liveKey = (e: Engine, id: string | undefined): Obj => {
  const k = e.db.apiKeys.get(id);
  if (!k) throw notFound('API key');
  return k;
};

const subjectExists = (e: Engine, type: string, id: string): boolean => {
  if (type === 'user') return !!e.db.users.get(id) && !e.db.users.get(id)?.deleted;
  if (type === 'organization') return !!e.db.organizations.get(id) && !e.db.organizations.get(id)?.deleted;
  if (type === 'machine') return !!e.db.machines.get(id) && !e.db.machines.get(id)?.deleted;
  return false;
};

export function keysHandlers(): RouteDef[] {
  const kEvent = (e: Engine, type: string, k: Obj, op: 'create' | 'update' | 'delete') => e.changed({ type, data: presentKey(e, k), resource: 'api_key', id: k.id, op });
  return [
    {
      method: 'GET',
      pattern: '/v1/api_keys',
      handler: (c) => {
        const t = c.query.get('subject_type');
        const s = c.query.get('subject_id');
        const org = c.query.get('organization_id');
        return listReply(c, c.engine.db.apiKeys.filter((k) => (!t || k.subject_type === t) && (!s || k.subject_id === s) && (!org || k.organization_id === org)), (k) => presentKey(c.engine, k));
      },
    },
    {
      method: 'POST',
      pattern: '/v1/api_keys',
      handler: async (c) => {
        const e = c.engine;
        foldMetadata(c.body);
        const credential = c.body.credential ?? 'secret';
        if (credential !== 'secret' && credential !== 'key_pair') throw new EmulatorError('VALIDATION_FAILED', 'credential must be "secret" or "key_pair".', 'credential');
        const keyPair = credential === 'key_pair';
        if (c.body.audience !== undefined && (!keyPair || typeof c.body.audience !== 'string' || c.body.audience.length < 1 || c.body.audience.length > 256)) {
          throw new EmulatorError('VALIDATION_FAILED', 'audience is a 1 to 256 character string and only applies to key_pair keys.', 'audience');
        }
        // Bring your own public key, or generate a P-256 pair whose private half is returned once.
        const holder = keyPair && c.body.public_key !== undefined ? await parseHolderPublicKey(c.body.public_key) : null;
        const generated = keyPair && !holder ? await generateKeyPair() : null;
        const type = String(need(c.body, 'subject_type'));
        const subject = String(need(c.body, 'subject_id'));
        if (!['user', 'organization', 'machine'].includes(type)) throw new EmulatorError('VALIDATION_FAILED', 'subject_type must be user, organization or machine.', 'subject_type');
        if (!subjectExists(e, type, subject)) throw new EmulatorError('NOT_FOUND', `The ${type} was not found.`, 'subject_id');
        const diesWith = diesWithOf(c.body.dies_with) ?? null;
        if (diesWith && type !== 'user') throw new EmulatorError('VALIDATION_FAILED', 'dies_with ends a key with a user signing out everywhere: send subject_type "user".', 'dies_with');
        const now = e.clock.now();
        const prefix = keyPair ? 'kp' : typeof c.body.prefix === 'string' ? c.body.prefix : 'ak';
        // A key pair has nothing to present as a bearer secret.
        const secret = keyPair ? null : e.tokens.secret(prefix);
        const pub = holder ?? generated;
        const k = e.db.apiKeys.insert({
          subject_type: type,
          subject_id: subject,
          name: c.body.name ?? null,
          prefix: secret ? secret.slice(0, prefix.length + 5) : prefix,
          secret,
          credential,
          audience: keyPair ? (c.body.audience ?? 'ins_emulator') : null,
          public_key: pub?.publicKey ?? null,
          public_key_jkt: pub?.jkt ?? null,
          claims: c.body.claims ?? {},
          dies_with: diesWith,
          scopes: c.body.scopes ?? null,
          constraints: c.body.constraints ?? null,
          enabled: c.body.enabled !== false,
          rate_limit: c.body.rate_limit ?? null,
          remaining: typeof c.body.remaining === 'number' ? c.body.remaining : null,
          last_used_at: null,
          expires_at: typeof c.body.expires_at === 'number' ? c.body.expires_at : typeof c.body.expires_in_seconds === 'number' ? now + c.body.expires_in_seconds * 1000 : null,
          revoked_at: null,
          allowed_ips: Array.isArray(c.body.allowed_ips) ? c.body.allowed_ips : [],
          organization_id: c.body.organization_id ?? null,
          created_at: now,
        });
        kEvent(e, 'api_key.created', k, 'create');
        return { status: 201, body: { ...presentKey(e, k), secret, ...(generated ? { private_key: generated.privateKey } : {}) } };
      },
    },
    { method: 'GET', pattern: '/v1/api_keys/:id', handler: (c) => ({ body: presentKey(c.engine, liveKey(c.engine, c.params.id)) }) },
    {
      method: 'PATCH',
      pattern: '/v1/api_keys/:id',
      handler: (c) => {
        const e = c.engine;
        const k = liveKey(e, c.params.id);
        foldMetadata(c.body);
        const diesWith = diesWithOf(c.body.dies_with);
        if (diesWith && k.subject_type !== 'user') throw new EmulatorError('VALIDATION_FAILED', 'dies_with ends a key with a user signing out everywhere: only a user key can carry it.', 'dies_with');
        if (diesWith !== undefined) k.dies_with = diesWith;
        for (const f of ['name', 'claims', 'scopes', 'constraints', 'enabled', 'rate_limit', 'remaining', 'expires_at']) if (f in c.body) k[f] = c.body[f];
        bump(e, k);
        kEvent(e, 'api_key.updated', k, 'update');
        return { body: presentKey(e, k) };
      },
    },
    {
      method: 'DELETE',
      pattern: '/v1/api_keys/:id',
      handler: (c) => {
        const e = c.engine;
        const k = liveKey(e, c.params.id);
        if (!k.revoked_at) {
          k.revoked_at = e.clock.now();
          k.revoked_by = { type: 'api_key', id: null };
          kEvent(e, 'api_key.revoked', k, 'update');
        }
        return { body: presentKey(e, k) };
      },
    },
    {
      method: 'POST',
      pattern: '/v1/api_keys/verify',
      handler: async (c) => {
        const e = c.engine;
        const hasSecret = c.body.secret !== undefined && c.body.secret !== null;
        const hasToken = c.body.token !== undefined && c.body.token !== null;
        if (hasSecret === hasToken) throw new EmulatorError('VALIDATION_FAILED', 'Send exactly one of secret or token.', 'token');
        const now = e.clock.now();
        const invalid = (extra: Obj = {}) => ({ body: { object: 'api_key_verification', valid: false, ...extra } });
        let k: Obj | undefined;
        let narrowed: string[] | null = null;
        let assertion: { jti: string | null; exp: number } | null = null;
        if (hasToken) {
          const token = String(c.body.token);
          const kid = peekKid(token);
          k = kid ? e.db.apiKeys.get(kid) : undefined;
          if (k?.credential !== 'key_pair') return invalid();
        } else {
          const secret = String(c.body.secret);
          k = e.db.apiKeys.find((x) => x.secret === secret);
        }
        if (!k || k.revoked_at || k.enabled === false || (k.expires_at && k.expires_at <= now) || !subjectExists(e, k.subject_type, k.subject_id)) return invalid();
        if (hasToken) {
          const verdict = await verifyAssertion(k as any, String(c.body.token), now);
          if (!verdict.ok) return invalid({ code: verdict.code, ...(verdict.authentic ? { id: k.id } : {}) });
          narrowed = narrowScopes(k.scopes ?? [], verdict.scope);
          if (narrowed === null) return invalid({ code: 'scope_not_granted', id: k.id });
          assertion = { jti: verdict.jti, exp: verdict.exp };
        }
        const required: string[] = c.body.required_scopes ?? [];
        const have: string[] = narrowed ?? k.scopes ?? [];
        if (required.some((s) => !have.includes(s) && !have.includes('*'))) return invalid({ code: 'insufficient_scope', id: k.id });
        if (k.remaining !== null && k.remaining !== undefined) {
          if (k.remaining <= 0) return invalid({ code: 'usage_exhausted', id: k.id });
          k.remaining -= 1;
        }
        // Single use until exp, claimed last once everything else allows it.
        if (assertion?.jti && !claimJti(k, assertion.jti, assertion.exp, now)) return invalid({ code: 'assertion_replayed', id: k.id });
        k.last_used_at = now;
        recordCaller(e, k.id, typeof c.body.client_ip === 'string' ? c.body.client_ip : null, c.request.headers.get('user-agent'));
        const scopes = narrowed ?? k.scopes ?? null;
        return {
          body: e.shape('ApiKeyVerificationValid', {
            object: 'api_key_verification',
            valid: true,
            id: k.id,
            subject_type: k.subject_type,
            subject_id: k.subject_id,
            name: k.name ?? null,
            claims: k.claims ?? {},
            metadata: k.claims ?? {},
            dies_with: k.dies_with ?? null,
            scopes,
            effective_scopes: scopes ?? [],
            last_used_at: k.last_used_at,
            expires_at: k.expires_at ?? null,
            ...(assertion ? { credential: 'key_pair', jti: assertion.jti, exp: assertion.exp } : {}),
          }),
        };
      },
    },
    {
      // Exchange a secret or a key-pair assertion for a short-lived access token (an sk_ bearer + body, or the credential itself as the bearer).
      method: 'POST',
      pattern: '/v1/api_keys/token',
      public: true,
      handler: async (c) => {
        const e = c.engine;
        const bearer = /^Bearer\s+(.+)$/i.exec(c.request.headers.get('authorization') ?? '')?.[1];
        let secret: string | undefined = c.body.secret;
        let assertion: string | undefined = c.body.assertion;
        if (bearer?.startsWith('sk_')) e.authenticateKey(c.request);
        else if (bearer && peekKid(bearer)) assertion = bearer;
        else if (bearer) secret = bearer;
        if ((secret === undefined) === (assertion === undefined)) throw new EmulatorError('VALIDATION_FAILED', 'Send exactly one of secret or assertion.', 'assertion');
        const now = e.clock.now();
        const refuse = (message: string) => new EmulatorError('INVALID_KEY', message);
        let k: Obj | undefined;
        if (assertion !== undefined) {
          const kid = peekKid(assertion);
          k = kid ? e.db.apiKeys.get(kid) : undefined;
          if (k?.credential !== 'key_pair') throw refuse('That key cannot mint a token.');
        } else {
          k = e.db.apiKeys.find((x) => x.secret === secret);
        }
        if (!k || k.revoked_at || k.enabled === false || (k.expires_at && k.expires_at <= now) || !subjectExists(e, k.subject_type, k.subject_id)) throw refuse('The API key is invalid or has been revoked.');
        let scopes: string[] = k.scopes ?? [];
        let jti: string | null = null;
        let capMs = Infinity;
        if (assertion !== undefined) {
          const verdict = await verifyAssertion(k as any, assertion, now);
          if (!verdict.ok) throw refuse(`That assertion was refused: ${verdict.code}.`);
          const narrowed = narrowScopes(scopes, verdict.scope);
          if (!narrowed) throw refuse('That assertion was refused: scope_not_granted.');
          scopes = narrowed;
          if (verdict.jti && !claimJti(k, verdict.jti, verdict.exp, now)) throw refuse('That assertion was refused: assertion_replayed.');
          jti = verdict.jti;
          // A token minted from an assertion never outlives the assertion.
          capMs = verdict.exp * 1000 - now;
        }
        const asked = typeof c.body.ttl_seconds === 'number' ? c.body.ttl_seconds : 900;
        const ttl = Math.max(1, Math.min(asked, 3600, k.max_token_lifetime_seconds ?? 3600, Math.floor(capMs / 1000), k.expires_at ? Math.floor((k.expires_at - now) / 1000) : Infinity));
        const tokenJti = jti ?? `tok_${k.id}_${now}`;
        k.last_used_at = now;
        const token = await e.tokens.signClaims({ sub: k.subject_id, key_id: k.id, subject_type: k.subject_type, scope: scopes.join(' '), jti: tokenJti }, ttl);
        // No cnf: the assertion's own signature is the proof of possession.
        return {
          status: 200,
          body: { object: 'api_key_token', token, token_type: 'Bearer', jti: tokenJti, key_id: k.id, subject_type: k.subject_type, subject_id: k.subject_id, scopes, constraints: k.constraints ?? {}, expires_in: ttl, expires_at: now + ttl * 1000, issuer: e.issuer },
        };
      },
    },
    {
      method: 'GET',
      pattern: '/v1/api_keys/revoked',
      handler: (c) => {
        const since = Number(c.query.get('since') ?? 0) || 0;
        const rows = c.engine.db.apiKeys.filter((k) => k.revoked_at && k.revoked_at > since);
        return listReply(c, rows, (k) => c.engine.shape('RevokedApiKey', { object: 'api_key', id: k.id, revoked_at: k.revoked_at, end_reason: endReason(k), revoked_by: endActor(k.revoked_by?.type, k.revoked_by?.id) }));
      },
    },
  ];
}
