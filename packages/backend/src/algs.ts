/**
 * The JWS algorithms Atlas signs tokens with. An instance key is RS256 (the
 * default), ES256, ES384, PS256 or EdDSA; APIs may be set to the algorithm of the
 * main key or of the one second key. Verification is pinned to this list — `none`
 * and HMAC never verify — and the token's `kid` selects exactly one published
 * key, whose type fixes which of them applies.
 */
export const ATLAS_SIGNING_ALGS = ['RS256', 'ES256', 'ES384', 'PS256', 'EdDSA'];
