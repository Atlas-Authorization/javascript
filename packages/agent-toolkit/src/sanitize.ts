/**
 * Keys that must never reach a model. `@atlasauth/backend`'s typed surfaces
 * already omit `private_metadata` from a `User`/`Organization`, but a tool
 * result is handed verbatim to an LLM — the one place a stray secret becomes a
 * leak that is logged, echoed, and potentially exfiltrated — so we strip these
 * defensively at the boundary rather than trusting every present and future
 * BAPI response to have done it for us.
 *
 * - `private_metadata` / `unsafe_metadata`: never model-safe by definition.
 * - `secret`: the one-time `ak_` value an api-key mint returns.
 * - `jwt` / `refresh_token` / `token`: bearer credentials some mint/token
 *   routes return in-body. The toolkit exposes no tool that returns one today,
 *   but the strip keeps that true if the surface grows.
 */
const REDACTED_KEYS: ReadonlySet<string> = new Set([
  'private_metadata',
  'unsafe_metadata',
  'secret',
  'jwt',
  'refresh_token',
  'token',
]);

/**
 * Deep-clone `value` into a plain JSON-serializable structure with every
 * {@link REDACTED_KEYS} entry removed. Returns a NEW value — the backend
 * response is never mutated. Non-plain values (functions, symbols, bigint) are
 * dropped the way `JSON.stringify` would, so the result is always safe to hand
 * to `JSON.stringify` and to a model.
 */
export function sanitize<T>(value: T): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (REDACTED_KEYS.has(key)) continue;
      out[key] = sanitize(v);
    }
    return out;
  }
  // Primitives pass through; anything JSON cannot represent is normalized out.
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'undefined') {
    return undefined;
  }
  return value;
}

export { REDACTED_KEYS };
