import type { MigrationTokenExtractor } from './migration-bridge';

/**
 * Magic (magic.link) DID tokens for the migration bridge. A Magic app sends
 * `magic.user.getIdToken()` to its server as `Authorization: Bearer <DID token>`;
 * a DID token is base64(JSON `[proof, claim]`), not a JWT, so the bridge's
 * generic Bearer reading (which routes on a JWT's `iss`) does not see it.
 * This extractor picks it out (by shape only — Atlas verifies the signature,
 * expiry and audience on exchange). Runs on every runtime (no Buffer).
 *
 *   migrationBridge({ source: 'magic', presetVars: { client_id }, extractToken: magicDidTokenExtractor() })
 */

const ISSUER = /^did:ethr:0x[0-9a-fA-F]{40}$/;

function header(headers: Parameters<MigrationTokenExtractor>[0]['headers'], name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === 'function') return (headers as { get(name: string): string | null }).get(name) ?? undefined;
  const record = headers as Record<string, string | string[] | undefined>;
  const value = record[name] ?? record[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

/** Is this a Magic DID token by shape (`[0x…proof, claim JSON with a did:ethr iss]`)? Nothing is verified. */
export function looksLikeMagicDidToken(token: string): boolean {
  if (!token || token.length > 16_384 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(token)) return false;
  try {
    const b64 = token.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(token.length / 4) * 4, '=');
    const outer = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))) as unknown;
    if (!Array.isArray(outer) || outer.length !== 2 || typeof outer[0] !== 'string' || typeof outer[1] !== 'string') return false;
    if (!/^0x[0-9a-fA-F]{130}$/.test(outer[0])) return false;
    const claim = JSON.parse(outer[1]) as { iss?: unknown };
    return typeof claim?.iss === 'string' && ISSUER.test(claim.iss);
  } catch {
    return false;
  }
}

/** The bridge token extractor for Magic: the DID token in `Authorization: Bearer`, when there is one. */
export function magicDidTokenExtractor(): MigrationTokenExtractor {
  return ({ headers }) => {
    const auth = header(headers, 'authorization');
    const m = auth ? /^Bearer\s+(\S+)$/i.exec(auth.trim()) : null;
    return m && looksLikeMagicDidToken(m[1]!) ? m[1] : undefined;
  };
}
