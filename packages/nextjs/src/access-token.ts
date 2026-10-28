import {
  createAccessTokenVerifier,
  type AccessTokenClaims,
  type AccessTokenVerifierOptions,
} from '@atlasauth/backend';

export {
  createAccessTokenVerifier,
  protectedResourceMetadata,
  protectedResourceMetadataPath,
  type AccessTokenClaims,
  type AccessTokenResult,
  type AccessTokenVerifierOptions,
} from '@atlasauth/backend';

/** The verified token handed to a {@link withAccessToken} route handler. */
export interface VerifiedAccessToken {
  claims: AccessTokenClaims;
  subject: string;
  clientId: string | null;
  scopes: string[];
}

/**
 * Wrap a Next.js route handler (App Router, any runtime) so it only runs for a
 * request carrying an Atlas-issued OAuth access token for YOUR API (audience,
 * scopes, DPoP when bound). Anything else gets 401/403 with the RFC 6750 /
 * RFC 9728 `WWW-Authenticate` challenge — what an MCP client needs to sign in.
 */
export function withAccessToken<Ctx = unknown>(
  options: AccessTokenVerifierOptions,
  handler: (request: Request, token: VerifiedAccessToken, ctx: Ctx) => Response | Promise<Response>,
): (request: Request, ctx: Ctx) => Promise<Response> {
  const verify = createAccessTokenVerifier(options);
  return async (request, ctx) => {
    const result = await verify({ method: request.method, url: request.url, headers: request.headers });
    if (!result.ok) {
      return new Response(
        JSON.stringify(
          result.error ? { error: result.error, error_description: result.description } : { error: 'unauthorized' },
        ),
        {
          status: result.status,
          headers: {
            'content-type': 'application/json',
            'www-authenticate': result.wwwAuthenticate,
            ...(result.dpopNonce ? { 'dpop-nonce': result.dpopNonce } : {}),
          },
        },
      );
    }
    const response = await handler(
      request,
      { claims: result.claims, subject: result.subject, clientId: result.clientId, scopes: result.scopes },
      ctx,
    );
    if (!result.dpopNonce) return response;
    // RFC 9449 §8 — the server nonce on success too. Some responses (e.g. a
    // fetched one) have immutable headers; those are re-wrapped.
    try {
      response.headers.set('dpop-nonce', result.dpopNonce);
      return response;
    } catch {
      const headers = new Headers(response.headers);
      headers.set('dpop-nonce', result.dpopNonce);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
  };
}
