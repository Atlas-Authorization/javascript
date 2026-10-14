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
 *     in a repo; our YAML is a deliberately small, fully-specified subset where
 *     every map key and every scalar is JSON-encoded, so it is unambiguous to
 *     parse, round-trips exactly (newlines, URL-shaped keys, unicode and all),
 *     and is still valid YAML (JSON is a YAML subset).
 */

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

interface Line {
  indent: number;
  content: string;
}

function parseYaml(text: string): Json {
  const lines: Line[] = [];
  for (const raw of text.split('\n')) {
    if (raw.trim() === '') continue;
    const indent = raw.length - raw.replace(/^ +/, '').length;
    lines.push({ indent, content: raw.slice(indent) });
  }
  if (lines.length === 0) return null;
  const first = lines[0]!;
  // A whole-document scalar or empty container (`42`, `"x"`, `true`, `[]`, `{}`)
  // is a single line that is neither a sequence item nor a `"key":` entry.
  if (lines.length === 1 && !isSeqLine(first.content) && !looksLikeMapEntry(first.content)) {
    return parseScalar(first.content, 0);
  }
  const [value, next] = parseBlock(lines, 0, first.indent);
  if (next !== lines.length) {
    throw new Error(`atlas config: malformed YAML near line ${next + 1}.`);
  }
  return value;
}

function isSeqLine(content: string): boolean {
  return content === '-' || content.startsWith('- ');
}

/** True when a line is a `"<json-key>":` map entry (vs. a bare scalar document). */
function looksLikeMapEntry(content: string): boolean {
  if (!content.startsWith('"')) return false;
  try {
    return content[jsonStringEnd(content) + 1] === ':';
  } catch {
    return false;
  }
}

function parseBlock(lines: Line[], pos: number, indent: number): [Json, number] {
  const first = lines[pos]!;
  if (first.content === '-' || first.content.startsWith('- ')) {
    return parseSeq(lines, pos, indent);
  }
  return parseMap(lines, pos, indent);
}

function parseMap(lines: Line[], pos: number, indent: number): [Json, number] {
  const out: { [k: string]: Json } = {};
  let i = pos;
  while (i < lines.length && lines[i]!.indent === indent) {
    const line = lines[i]!;
    if (line.content.startsWith('- ') || line.content === '-') break;
    const { key, rest } = splitKey(line.content, i);
    if (rest === '') {
      // Nested block on the following, more-indented lines.
      if (i + 1 >= lines.length || lines[i + 1]!.indent <= indent) {
        throw new Error(`atlas config: expected a nested block after '${key}:' (line ${i + 1}).`);
      }
      const [value, next] = parseBlock(lines, i + 1, lines[i + 1]!.indent);
      out[key] = value;
      i = next;
    } else {
      out[key] = parseScalar(rest, i);
      i += 1;
    }
  }
  return [out, i];
}

function parseSeq(lines: Line[], pos: number, indent: number): [Json, number] {
  const out: Json[] = [];
  let i = pos;
  while (i < lines.length && lines[i]!.indent === indent) {
    const line = lines[i]!;
    if (!(line.content === '-' || line.content.startsWith('- '))) break;
    const rest = line.content === '-' ? '' : line.content.slice(2);
    if (rest === '') {
      if (i + 1 >= lines.length || lines[i + 1]!.indent <= indent) {
        throw new Error(`atlas config: expected a nested block after '-' (line ${i + 1}).`);
      }
      const [value, next] = parseBlock(lines, i + 1, lines[i + 1]!.indent);
      out.push(value);
      i = next;
    } else {
      out.push(parseScalar(rest, i));
      i += 1;
    }
  }
  return [out, i];
}

/** Split `"<json-key>": <rest>` (or `"<json-key>":`) into the decoded key and the rest. */
function splitKey(content: string, lineNo: number): { key: string; rest: string } {
  if (!content.startsWith('"')) {
    throw new Error(`atlas config: expected a quoted key (line ${lineNo + 1}): ${content}`);
  }
  const end = jsonStringEnd(content);
  const key = JSON.parse(content.slice(0, end + 1)) as string;
  let after = content.slice(end + 1);
  if (!after.startsWith(':')) {
    throw new Error(`atlas config: expected ':' after key (line ${lineNo + 1}): ${content}`);
  }
  after = after.slice(1);
  return { key, rest: after.startsWith(' ') ? after.slice(1) : after };
}

/** Find the index of the closing quote of the JSON string that starts at index 0. */
function jsonStringEnd(s: string): number {
  let i = 1;
  while (i < s.length) {
    if (s[i] === '\\') {
      i += 2;
      continue;
    }
    if (s[i] === '"') return i;
    i += 1;
  }
  throw new Error(`atlas config: unterminated quoted string: ${s}`);
}

function parseScalar(rest: string, lineNo: number): Json {
  if (rest === '[]') return [];
  if (rest === '{}') return {};
  try {
    return JSON.parse(rest) as Json;
  } catch {
    throw new Error(`atlas config: invalid scalar (line ${lineNo + 1}): ${rest}`);
  }
}
