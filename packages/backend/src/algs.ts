/**
 * The JWS algorithms Atlas signs tokens with. An instance key is RS256 (the
 * default) or ES256; APIs may be set to either. Verification is pinned to this
 * list — `none` and HMAC never verify — and the token's `kid` selects exactly
 * one published key, whose type fixes which of the two applies.
 */
export const ATLAS_SIGNING_ALGS = ['RS256', 'ES256'];
