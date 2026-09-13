import { getCookie, getQuery, getRequestURL, sendRedirect, setCookie, type H3Event } from 'h3';
import { useRuntimeConfig } from '#imports';
import { createPkcePair, redeemHandshake } from '@atlasauth/backend';
import { getAtlasAuth } from './index';

/**
 * Cross-property SSO handshake for a Nuxt/Nitro route — the peer of the Next.js
 * `atlasMiddleware({ handshake: true })`. Call it at the top of a protected
 * server route: if the visitor has no local session it bounces them once
 * through the Atlas handshake, and on the way back it redeems the cross-domain
 * nonce for a fresh FIRST-PARTY session on this property (setting `__session` +
 * `__atlas_rt`). Returns `true` when it has issued a redirect (the caller should
 * stop and return); `false` when the request may proceed (signed in, or the
 * handshake reported signed-out — send them to your sign-in then).
 *
 * ```ts
 * export default defineEventHandler(async (event) => {
 *   if (await atlasHandshake(event)) return;   // redirected
 *   const auth = await getAtlasAuth(event);
 *   auth.protect();
 *   return { userId: auth.userId };
 * });
 * ```
 *
 * Requires `runtimeConfig.atlas.publishableKey` (and `jwksUrl`, from which the
 * FAPI origin is derived unless `atlas.fapiOrigin` is set).
 */
export async function atlasHandshake(event: H3Event): Promise<boolean> {
  const { atlas } = useRuntimeConfig() as {
    atlas: { jwksUrl?: string; fapiOrigin?: string; publishableKey?: string };
  };
  const publishableKey = atlas.publishableKey;
  const fapiOrigin = atlas.fapiOrigin ?? (atlas.jwksUrl ? new URL(atlas.jwksUrl).origin : undefined);
  if (!publishableKey || !fapiOrigin) {
    // Not configured for the handshake — treat as a no-op so route logic runs.
    return false;
  }

  const q = getQuery(event) as Record<string, string | undefined>;
  const url = getRequestURL(event);

  // Returning from the handshake for a cross-domain satellite: exchange the
  // single-use nonce for a fresh first-party session and set our own cookies.
  if (q.__atlas_hs === 'ok' && q.__atlas_hu && q.__atlas_hn) {
    // PKCE proof: redeem only with the verifier we stashed HttpOnly on the way
    // out (its challenge was bound to this nonce at mint time). A leaked nonce
    // without the verifier is inert — a missing verifier can never redeem.
    const codeVerifier = getCookie(event, '__atlas_hv');
    const session = codeVerifier
      ? await redeemHandshake({
          fapiOrigin,
          publishableKey,
          userId: q.__atlas_hu,
          nonce: q.__atlas_hn,
          codeVerifier,
        })
      : null;
    const clean = new URL(url.toString());
    for (const k of ['__atlas_hs', '__atlas_hu', '__atlas_hn']) clean.searchParams.delete(k);
    // The verifier is spent either way — clear it.
    setCookie(event, '__atlas_hv', '', { path: '/', maxAge: 0 });
    if (session) {
      setCookie(event, '__session', session.jwt, { path: '/', sameSite: 'lax', secure: true });
      setCookie(event, '__atlas_rt', session.refreshToken, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
      });
      await sendRedirect(event, clean.pathname + clean.search, 303);
      return true;
    }
    // Redeem failed / rejected proof / no verifier → carry a SPENT marker so we
    // don't bounce back to the handshake forever; the route then sends to sign-in.
    clean.searchParams.set('__atlas_hs', 'failed');
    await sendRedirect(event, clean.pathname + clean.search, 303);
    return true;
  }

  // Already signed in (subdomain shared cookie, or a prior handshake) → proceed.
  const auth = await getAtlasAuth(event);
  if (auth.userId) return false;

  // Not signed in and no handshake attempted yet → bounce once. The `__atlas_hs`
  // marker on the way back is the loop guard.
  if (!q.__atlas_hs) {
    // Only the PKCE challenge rides the (loggable) handshake URL; the verifier
    // is stashed HttpOnly and proves possession at redeem.
    const { verifier, challenge } = await createPkcePair();
    setCookie(event, '__atlas_hv', verifier, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      maxAge: 300,
    });
    const hs = new URL('/v1/client/handshake', fapiOrigin);
    hs.searchParams.set('publishable_key', publishableKey);
    hs.searchParams.set('redirect_url', url.toString());
    hs.searchParams.set('code_challenge', challenge);
    await sendRedirect(event, hs.toString(), 303);
    return true;
  }

  // `__atlas_hs=signed_out` → nobody is signed in anywhere; let the route decide.
  return false;
}
