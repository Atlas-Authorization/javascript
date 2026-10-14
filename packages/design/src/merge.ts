/**
 * What a PARTIAL design means — the one merge rule behind every layered design
 * write (a dashboard PATCH, an org override, a draft).
 *
 * Nested objects merge, arrays and scalars replace, and an explicit `null`
 * REMOVES the key (so it falls back to the preset/defaults on resolve). Arrays
 * replace wholesale on purpose: two gradient stops sent as a patch mean "these
 * are the stops now", not "add two".
 */

type Plain = Record<string, unknown>;

/** Keys that must never be merged — walking them is a prototype-pollution bug. */
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);

const isPlain = (v: unknown): v is Plain => !!v && typeof v === 'object' && !Array.isArray(v);

/** Apply `patch` over `base`: merge objects, replace arrays and scalars, delete on `null`. */
export function mergePatch(base: Plain, patch: Plain): Plain {
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (FORBIDDEN.has(k)) continue;
    if (v === undefined) continue;
    if (v === null) {
      delete out[k];
      continue;
    }
    const b = out[k];
    out[k] = isPlain(b) && isPlain(v) ? mergePatch(b, v) : v;
  }
  return out;
}

/** Drop objects a delete emptied (`{ card: {} }` → `{}`) so the stored design stays minimal. */
export function pruneEmpty(v: Plain): Plain {
  const out: Plain = {};
  for (const [k, val] of Object.entries(v)) {
    if (isPlain(val)) {
      const inner = pruneEmpty(val);
      if (Object.keys(inner).length) out[k] = inner;
    } else out[k] = val;
  }
  return out;
}
