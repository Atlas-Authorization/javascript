import { createHmac, randomBytes } from 'node:crypto';

/**
 * Vercel BotID for Atlas — the server half that runs on YOUR Vercel deployment.
 *
 * BotID's verdict only exists inside a Vercel-hosted request (`checkBotId()`
 * from `botid/server` reads signals Vercel's edge attaches). Atlas is not that
 * request, so your route runs `checkBotId()` and turns the verdict into a short
 * signed attestation; the browser sends it to Atlas as `captcha_token`, and
 * Atlas checks the signature, freshness and `isBot === false`, and spends it
 * (each attestation passes once).
 *
 *   // app/api/atlas/botid/route.ts (Next.js on Vercel)
 *   import { checkBotId } from 'botid/server';
 *   import { botIdAttestationHandler } from '@atlasauth/backend';
 *   export const POST = botIdAttestationHandler({
 *     secret: process.env.ATLAS_BOTID_SECRET!,
 *     checkBotId,
 *   });
 *
 * The same secret is stored in Atlas for the `vercel_botid` captcha provider.
 * Protect the route with BotID on the client (`initBotId({ protect: [{ path:
 * '/api/atlas/botid', method: 'POST' }] })`) and set the captcha's
 * `attestationUrl` to it, so the prebuilt components fetch a verdict on submit.
 *
 * Format (version 1): `atlas_botid.v1.<payload>.<sig>` — `payload` is base64url
 * JSON `{ v: 1, is_bot, verified_bot, iat, exp, jti }`, `sig` is base64url
 * HMAC-SHA256 over `atlas_botid.v1.<payload>` keyed by the shared secret.
 */

/** The prefix every attestation carries. */
export const BOTID_ATTESTATION_PREFIX = 'atlas_botid.v1.';

/** Atlas refuses attestations that live longer than this, in seconds. */
export const BOTID_ATTESTATION_MAX_TTL_SECONDS = 300;

/** Atlas refuses secrets shorter than this. */
export const BOTID_SECRET_MIN_LENGTH = 32;

/** The fields of BotID's `checkBotId()` result this helper reads. */
export interface BotIdVerdict {
  isBot: boolean;
  /** True for a known good bot (a search engine crawler). Recorded, still refused. */
  isVerifiedBot?: boolean;
}

export interface CreateBotIdAttestationOptions {
  /** The attestation secret shared with Atlas (at least 32 characters). */
  secret: string;
  /** The verdict `checkBotId()` returned for this request. */
  verdict: BotIdVerdict;
  /** Lifetime in seconds. Default 60, at most 300. */
  ttlSeconds?: number;
  /** Clock override, epoch ms (tests). */
  now?: number;
}

/**
 * Sign a BotID verdict for Atlas. Throws when the secret is too short (Atlas
 * would refuse every attestation it signs). A bot verdict is still signed — it
 * is Atlas that refuses it — so your route needs no branching.
 */
export function createBotIdAttestation(options: CreateBotIdAttestationOptions): string {
  const { secret, verdict } = options;
  if (typeof secret !== 'string' || secret.length < BOTID_SECRET_MIN_LENGTH) {
    throw new Error(`The BotID attestation secret must be at least ${BOTID_SECRET_MIN_LENGTH} characters.`);
  }
  const ttl = Math.min(Math.max(Math.floor(options.ttlSeconds ?? 60), 1), BOTID_ATTESTATION_MAX_TTL_SECONDS);
  const iat = Math.floor((options.now ?? Date.now()) / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      is_bot: verdict.isBot !== false,
      verified_bot: verdict.isVerifiedBot === true,
      iat,
      exp: iat + ttl,
      jti: randomBytes(18).toString('base64url'),
    }),
    'utf8',
  ).toString('base64url');
  const sig = createHmac('sha256', secret).update(BOTID_ATTESTATION_PREFIX + payload).digest('base64url');
  return `${BOTID_ATTESTATION_PREFIX}${payload}.${sig}`;
}

export interface BotIdAttestationHandlerOptions {
  /** The attestation secret shared with Atlas. */
  secret: string;
  /** `checkBotId` from `botid/server`. */
  checkBotId: () => Promise<BotIdVerdict>;
  /** Lifetime of each attestation in seconds. Default 60. */
  ttlSeconds?: number;
}

/**
 * A Web-standard `(request) => Response` route handler (Next.js App Router,
 * Hono, any fetch-style runtime): runs `checkBotId()` and answers
 * `{ token }` with the signed attestation, `no-store`. A BotID failure answers
 * 503 so the client never sends a token that was never checked.
 */
export function botIdAttestationHandler(options: BotIdAttestationHandlerOptions): (request?: Request) => Promise<Response> {
  return async () => {
    let verdict: BotIdVerdict;
    try {
      verdict = await options.checkBotId();
    } catch {
      return new Response(JSON.stringify({ error: 'botid_unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    }
    const token = createBotIdAttestation({ secret: options.secret, verdict, ttlSeconds: options.ttlSeconds });
    return new Response(JSON.stringify({ token }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  };
}
