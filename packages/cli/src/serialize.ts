/**
 * The on-disk format for `atlas config` — the config-as-code layer. Two
 * concerns live here, kept away from the command logic:
 *
 *  1. CANONICALIZATION. A value is normalised before it is written or compared
 *     so an export is byte-for-byte deterministic and a round-trip is a no-op
 *     diff. We sort object keys (the same rule Go's `json.Marshal` and the
 *     Terraform provider's `canonicalJSON` use) and PRESERVE array order — so a
 *     field whose order is meaningful (a claim mapping, an auth_config list) is
 *     never silently reordered.
 *
 *  2. THE CODEC. JSON is the robust default. YAML is offered for readable diffs
 *     in a repo; we WRITE a small subset where every map key and every scalar is
 *     JSON-encoded (it round-trips exactly: newlines, URL-shaped keys, unicode),
 *     and READ any YAML, so a hand-written atlas.yaml works too.
 */

import { parse as parseYamlDocument } from 'yaml';

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export type Format = 'json' | 'yaml';

/** A plain JSON value with all object keys recursively sorted; arrays untouched. */
export function canonicalize(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => canonicalize(v));
  if (typeof value === 'object') {
    const out: { [k: string]: Json } = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue; // omit undefined so it never reaches disk
      out[key] = canonicalize(v);
    }
    return out;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  // Functions, symbols, bigint: not part of a config document.
  return null;
}

/** Canonical JSON string — the equality oracle for the diff engine. */
export function canonicalString(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** True when two config values are equal after canonicalization. */
export function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalString(a) === canonicalString(b);
}

/** Serialize a canonicalizable value to the chosen format, with a trailing newline. */
export function serialize(value: unknown, format: Format): string {
  const canon = canonicalize(value);
  if (format === 'json') return JSON.stringify(canon, null, 2) + '\n';
  return emitYaml(canon, 0) + '\n';
}

/** Parse a document written by {@link serialize}. */
export function deserialize(text: string, format: Format): Json {
  if (format === 'json') return JSON.parse(text) as Json;
  return parseYaml(text);
}

// ─────────────────────────────── YAML emit ───────────────────────────────

const INDENT = '  ';

function emitYaml(value: Json, depth: number): string {
  const pad = INDENT.repeat(depth);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]`;
    return value.map((item) => emitSeqItem(item, depth)).join('\n');
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 0) return `${pad}{}`;
    return keys.map((key) => emitMapEntry(key, value[key] as Json, depth)).join('\n');
  }
  // A bare scalar document.
  return `${pad}${JSON.stringify(value)}`;
}

function emitMapEntry(key: string, value: Json, depth: number): string {
  const pad = INDENT.repeat(depth);
  const k = JSON.stringify(key);
  if (isContainer(value) && !isEmptyContainer(value)) {
    return `${pad}${k}:\n${emitYaml(value, depth + 1)}`;
  }
  return `${pad}${k}: ${scalarOrEmpty(value)}`;
}

function emitSeqItem(value: Json, depth: number): string {
  const pad = INDENT.repeat(depth);
  if (isContainer(value) && !isEmptyContainer(value)) {
    return `${pad}-\n${emitYaml(value, depth + 1)}`;
  }
  return `${pad}- ${scalarOrEmpty(value)}`;
}

function scalarOrEmpty(value: Json): string {
  if (Array.isArray(value)) return '[]';
  if (value !== null && typeof value === 'object') return '{}';
  return JSON.stringify(value);
}

function isContainer(v: Json): boolean {
  return Array.isArray(v) || (v !== null && typeof v === 'object');
}
function isEmptyContainer(v: Json): boolean {
  if (Array.isArray(v)) return v.length === 0;
  if (v !== null && typeof v === 'object') return Object.keys(v).length === 0;
  return false;
}

// ─────────────────────────────── YAML parse ───────────────────────────────

/**
 * Any YAML 1.2 document: our own export (JSON-encoded keys and scalars) and a
 * hand-written atlas.yaml with plain keys alike.
 */
function parseYaml(text: string): Json {
  try {
    return (parseYamlDocument(text) ?? null) as Json;
  } catch (err) {
    throw new Error(`atlas config: invalid YAML: ${(err as Error).message}`);
  }
}
