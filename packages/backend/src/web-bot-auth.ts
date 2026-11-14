/**
 * Web Bot Auth: verify who is behind an automated request.
 *
 * A bot signs its requests with an Ed25519 key (RFC 9421 HTTP Message
 * Signatures, tag `web-bot-auth`) and names the place its public keys live in
 * the `Signature-Agent` header. The key is found in the directory served at
 * `<Signature-Agent>/.well-known/http-message-signatures-directory`, and the
 * signature's `keyid` is the RFC 7638 JWK thumbprint of that key.
 *
 * This file is the single implementation: the Atlas API and the local verifier in
 * this package both run it. It needs no Node built-ins, so it works on edge
 * runtimes. Fetching the directory is injected, so each caller brings its own
 * network policy (the API uses its SSRF-safe transport).
 *
 * Sources: RFC 9421 (https://www.rfc-editor.org/rfc/rfc9421), RFC 8941 (structured
 * fields), RFC 7638 (JWK thumbprint), the web-bot-auth architecture and
 * http-message-signatures-directory drafts.
 */
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';

export const WEB_BOT_AUTH_TAG = 'web-bot-auth';
export const WEB_BOT_AUTH_DIRECTORY_PATH = '/.well-known/http-message-signatures-directory';
export const WEB_BOT_AUTH_DIRECTORY_MEDIA_TYPE = 'application/http-message-signatures-directory+json';

/** Clock skew tolerated on `created` and `expires`, in seconds. */
export const WEB_BOT_AUTH_DEFAULT_SKEW_SECONDS = 30;
/** The longest `expires - created` accepted, in seconds. */
export const WEB_BOT_AUTH_DEFAULT_MAX_LIFETIME_SECONDS = 3600;

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

export function bytesToBase64Url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(input: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) return null;
  return base64ToBytes(input.replace(/-/g, '+').replace(/_/g, '/'));
}

function base64ToBytes(input: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(input)) return null;
  const padded = input + '='.repeat((4 - (input.length % 4)) % 4);
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// ---------------------------------------------------------------------------
// JWKs and thumbprints
// ---------------------------------------------------------------------------

/** An Ed25519 public key as a JWK. */
export interface WebBotAuthJwk {
  kty: 'OKP';
  crv: 'Ed25519';
  x: string;
  [k: string]: unknown;
}

/** RFC 7638 thumbprint (base64url SHA-256) of an Ed25519 public JWK: the web-bot-auth `keyid`. */
export function ed25519JwkThumbprint(jwk: { x: string }): string {
  const canonical = `{"crv":"Ed25519","kty":"OKP","x":"${jwk.x}"}`;
  return bytesToBase64Url(sha256(enc.encode(canonical)));
}

/** The raw 32-byte public key of a JWK, or null when it is not a well-formed Ed25519 key. */
export function ed25519JwkBytes(jwk: unknown): Uint8Array | null {
  const k = jwk as Partial<WebBotAuthJwk> | null;
  if (!k || typeof k !== 'object' || k.kty !== 'OKP' || k.crv !== 'Ed25519' || typeof k.x !== 'string') return null;
  const bytes = base64UrlToBytes(k.x);
  return bytes && bytes.length === 32 ? bytes : null;
}

/** Pick the usable Ed25519 keys out of a directory document (a JWK Set). At most 20 are kept. */
export function parseDirectory(doc: unknown): WebBotAuthJwk[] {
  const keys = (doc as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys)) return [];
  return keys.filter((k): k is WebBotAuthJwk => ed25519JwkBytes(k) !== null).slice(0, 20);
}

// ---------------------------------------------------------------------------
// Structured fields (the subset RFC 9421 headers use)
// ---------------------------------------------------------------------------

type SfParam = string | number | boolean | Uint8Array;
type SfParams = Record<string, SfParam>;

const KEY_RE = /^[a-z*][a-z0-9_.*-]*$/;
const TOKEN_CHARS = /[A-Za-z0-9:/!#$%&'*+\-.^_`|~]/;

/** Split on `sep` outside of strings and parentheses. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '\\') i++;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === sep && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((m) => m.trim()).filter((m) => m.length > 0);
}

/** Read a quoted sf-string starting at `i` (which must be the opening quote). */
function readString(s: string, i: number): { value: string; end: number } | null {
  if (s[i] !== '"') return null;
  let out = '';
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j]!;
    if (c === '\\') {
      const n = s[j + 1];
      if (n !== '"' && n !== '\\') return null;
      out += n;
      j++;
    } else if (c === '"') return { value: out, end: j + 1 };
    else if (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) > 0x7e) return null;
    else out += c;
  }
  return null;
}

/** Parse `;k=v;k2` (possibly empty). Null when malformed. */
function parseParams(text: string): SfParams | null {
  const out: SfParams = {};
  let i = 0;
  while (i < text.length) {
    if (text[i] !== ';') return null;
    i++;
    let key = '';
    while (i < text.length && /[a-z0-9_.*-]/.test(text[i]!)) key += text[i++];
    if (!KEY_RE.test(key)) return null;
    if (text[i] !== '=') {
      out[key] = true;
      continue;
    }
    i++;
    const c = text[i];
    if (c === '"') {
      const str = readString(text, i);
      if (!str) return null;
      out[key] = str.value;
      i = str.end;
    } else if (c === ':') {
      const close = text.indexOf(':', i + 1);
      if (close < 0) return null;
      const bytes = base64ToBytes(text.slice(i + 1, close));
      if (!bytes) return null;
      out[key] = bytes;
      i = close + 1;
    } else if (c === '?') {
      const b = text.slice(i, i + 2);
      if (b !== '?0' && b !== '?1') return null;
      out[key] = b === '?1';
      i += 2;
    } else if (c !== undefined && /[-0-9]/.test(c)) {
      let n = '';
      while (i < text.length && /[-0-9.]/.test(text[i]!)) n += text[i++];
      if (!/^-?\d{1,15}(\.\d{1,3})?$/.test(n)) return null;
      out[key] = Number(n);
    } else if (c !== undefined && /[A-Za-z*]/.test(c)) {
      let t = '';
      while (i < text.length && TOKEN_CHARS.test(text[i]!)) t += text[i++];
      out[key] = t;
    } else return null;
  }
  return out;
}

interface Component {
  name: string;
  params: SfParams;
}

interface ParsedSignatureInput {
  label: string;
  components: Component[];
  params: SfParams;
  /** The inner list and its parameters exactly as sent: the `@signature-params` value. */
  raw: string;
}

/** Parse a `Signature-Input` field. Null when any member is malformed. */
export function parseSignatureInput(header: string): ParsedSignatureInput[] | null {
  const out: ParsedSignatureInput[] = [];
  for (const member of splitTop(header, ',')) {
    const eq = member.indexOf('=');
    if (eq <= 0) return null;
    const label = member.slice(0, eq).trim();
    const raw = member.slice(eq + 1).trim();
    if (!KEY_RE.test(label) || raw[0] !== '(') return null;
    let close = -1;
    let quoted = false;
    for (let i = 1; i < raw.length; i++) {
      const c = raw[i]!;
      if (quoted) {
        if (c === '\\') i++;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === ')') {
        close = i;
        break;
      }
    }
    if (close < 0) return null;
    const components: Component[] = [];
    const inner = raw.slice(1, close);
    let i = 0;
    while (i < inner.length) {
      if (inner[i] === ' ') {
        i++;
        continue;
      }
      const str = readString(inner, i);
      if (!str) return null;
      i = str.end;
      let ptext = '';
      while (i < inner.length && inner[i] !== ' ') {
        if (inner[i] === '"') {
          const q = readString(inner, i);
          if (!q) return null;
          ptext += inner.slice(i, q.end);
          i = q.end;
        } else ptext += inner[i++];
      }
      const params = parseParams(ptext);
      if (!params) return null;
      components.push({ name: str.value, params });
    }
    const params = parseParams(raw.slice(close + 1));
    if (!params) return null;
    out.push({ label, components, params, raw });
  }
  return out.length > 0 ? out : null;
}

/** Parse a `Signature` field into label -> signature bytes. Null when malformed. */
export function parseSignatureHeader(header: string): Map<string, Uint8Array> | null {
  const out = new Map<string, Uint8Array>();
  for (const member of splitTop(header, ',')) {
    const m = /^([a-z*][a-z0-9_.*-]*)=:([A-Za-z0-9+/=]*):$/.exec(member);
    if (!m) return null;
    const bytes = base64ToBytes(m[2]!);
    if (!bytes) return null;
    out.set(m[1]!, bytes);
  }
  return out.size > 0 ? out : null;
}

/**
 * The directory a `Signature-Agent` value names, normalised: https, no
 * credentials, query or fragment, no trailing slash. Accepts a quoted string
 * (`"https://bot.example"`), a bare URL, or the dictionary form
 * (`sig1="https://bot.example"`; the member for `label` wins, else the first).
 * Null when it names nothing usable.
 */
export function parseSignatureAgent(value: string, label?: string): string | null {
  let v = value.trim();
  if (v.length === 0) return null;
  if (/^[a-z*][a-z0-9_.*-]*=/.test(v)) {
    const members = splitTop(v, ',');
    const pick = members.find((m) => label !== undefined && m.startsWith(`${label}=`)) ?? members[0]!;
    v = pick.slice(pick.indexOf('=') + 1).trim();
  }
  if (v.startsWith('"')) {
    const str = readString(v, 0);
    if (!str || str.end !== v.length) return null;
    v = str.value;
  }
  return normalizeDirectory(v);
}

/**
 * Canonical form of a directory reference: `https://host[:port][/path]`. A bare
 * host gets `https://`. Null for anything that is not an https URL without
 * credentials, query or fragment.
 */
export function normalizeDirectory(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || !u.hostname) return null;
  return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** The URL the directory is fetched from. */
export const directoryUrlFor = (directory: string): string => `${directory}${WEB_BOT_AUTH_DIRECTORY_PATH}`;

// ---------------------------------------------------------------------------
// Signature base (RFC 9421 section 2.5)
// ---------------------------------------------------------------------------

export type WebBotAuthHeaders = Headers | Record<string, string | string[] | undefined>;

export interface WebBotAuthRequest {
  /** The HTTP method. */
  method: string;
  /** The absolute request URL as the origin server saw it (scheme, host, path, query). */
  url: string;
  headers: WebBotAuthHeaders;
}

/** A header's value as RFC 9421 reads it: fields of one name joined with ", ", whitespace trimmed. Undefined when absent. */
export function headerValue(headers: WebBotAuthHeaders, name: string): string | undefined {
  const lower = name.toLowerCase();
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const v = headers.get(lower);
    return v === null ? undefined : v.trim();
  }
  const parts: string[] = [];
  for (const [k, v] of Object.entries(headers as Record<string, string | string[] | undefined>)) {
    if (k.toLowerCase() !== lower || v === undefined) continue;
    for (const item of Array.isArray(v) ? v : [v]) parts.push(item.trim());
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

const DERIVED = new Set(['@method', '@authority', '@path', '@target-uri', '@scheme', '@query', '@request-target']);

function componentValue(name: string, req: WebBotAuthRequest, url: URL): string | undefined {
  switch (name) {
    case '@method':
      return req.method.toUpperCase();
    case '@authority':
      return url.host.toLowerCase();
    case '@path':
      return url.pathname === '' ? '/' : url.pathname;
    case '@target-uri':
      return url.href;
    case '@scheme':
      return url.protocol.replace(/:$/, '').toLowerCase();
    case '@query':
      return url.search === '' ? '?' : url.search;
    case '@request-target':
      return `${url.pathname === '' ? '/' : url.pathname}${url.search}`;
    default:
      return headerValue(req.headers, name);
  }
}

/**
 * Build the RFC 9421 signature base: one `"id": value` line per covered
 * component, then the `@signature-params` line. `signatureParams` is the inner
 * list with its parameters, serialised exactly as it appears in `Signature-Input`.
 * Returns a failure reason instead of a base when a component is unsupported or
 * missing.
 */
export function buildSignatureBase(
  req: WebBotAuthRequest,
  componentNames: readonly string[],
  signatureParams: string,
): { base: string } | { error: 'unsupported_component' | 'component_missing' | 'bad_request' } {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return { error: 'bad_request' };
  }
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const name of componentNames) {
    if (name !== name.toLowerCase() || seen.has(name)) return { error: 'unsupported_component' };
    if (name.startsWith('@') && !DERIVED.has(name)) return { error: 'unsupported_component' };
    seen.add(name);
    const v = componentValue(name, req, url);
    if (v === undefined || /[\r\n]/.test(v)) return { error: 'component_missing' };
    lines.push(`"${name}": ${v}`);
  }
  lines.push(`"@signature-params": ${signatureParams}`);
  return { base: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export type WebBotAuthFailure =
  | 'no_signature'
  | 'no_web_bot_auth_signature'
  | 'malformed'
  | 'missing_signature_agent'
  | 'bad_signature_agent'
  | 'bad_params'
  | 'unsupported_algorithm'
  | 'unsupported_component'
  | 'component_missing'
  | 'components_not_covered'
  | 'bad_request'
  | 'not_yet_valid'
  | 'expired'
  | 'lifetime_too_long'
  | 'directory_unavailable'
  | 'key_not_found'
  | 'bad_signature'
  | 'replayed';

export interface WebBotAuthResult {
  /** True when the request carried a signature header at all. */
  signed: boolean;
  verified: boolean;
  reason?: WebBotAuthFailure;
  /** The normalised directory the signer claims (set once `Signature-Agent` parsed; trust it only when `verified`). */
  directory?: string;
  keyId?: string;
  label?: string;
  created?: number;
  expires?: number;
  nonce?: string | null;
}

export interface WebBotAuthVerifyOptions {
  /** Directory keys for a directory URL. `refresh` asks for a fresh copy (the key was not in the cached one). Null = unavailable. */
  getKeys: (directoryUrl: string, opts: { refresh: boolean }) => Promise<WebBotAuthJwk[] | null>;
  /** Epoch ms; defaults to now. */
  now?: number;
  skewSeconds?: number;
  maxLifetimeSeconds?: number;
  /**
   * Replay guard: called after the signature verified, with a key unique to the
   * signature's nonce, returns true the first time it is seen. Without it nonces
   * are not tracked.
   */
  claimNonce?: (key: string, expiresAtMs: number) => Promise<boolean>;
}

const fail = (reason: WebBotAuthFailure, extra: Partial<WebBotAuthResult> = {}): WebBotAuthResult => ({
  signed: true,
  verified: false,
  reason,
  ...extra,
});

/** Verify the web-bot-auth signature on a request. Never throws on bad input. */
export async function verifyWebBotAuth(req: WebBotAuthRequest, opts: WebBotAuthVerifyOptions): Promise<WebBotAuthResult> {
  const inputHeader = headerValue(req.headers, 'signature-input');
  const sigHeader = headerValue(req.headers, 'signature');
  if (inputHeader === undefined || sigHeader === undefined) return { signed: false, verified: false, reason: 'no_signature' };

  const inputs = parseSignatureInput(inputHeader);
  const sigs = parseSignatureHeader(sigHeader);
  if (!inputs || !sigs) return fail('malformed');
  const input = inputs.find((i) => i.params.tag === WEB_BOT_AUTH_TAG && sigs.has(i.label));
  if (!input) return fail('no_web_bot_auth_signature');
  const signature = sigs.get(input.label)!;
  const p = input.params;

  const created = p.created;
  const expires = p.expires;
  const keyId = p.keyid;
  const nonce = p.nonce;
  if (
    typeof created !== 'number' || !Number.isInteger(created) ||
    typeof expires !== 'number' || !Number.isInteger(expires) ||
    typeof keyId !== 'string' || keyId.length === 0 || keyId.length > 128 ||
    (nonce !== undefined && (typeof nonce !== 'string' || nonce.length > 512))
  ) {
    return fail('bad_params', { label: input.label });
  }
  const base = { label: input.label, keyId, created, expires };
  if (p.alg !== undefined && p.alg !== 'ed25519') return fail('unsupported_algorithm', base);

  // Time window: created not in the future, expires not in the past, both within a small skew.
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
  const skew = opts.skewSeconds ?? WEB_BOT_AUTH_DEFAULT_SKEW_SECONDS;
  if (expires <= created) return fail('bad_params', base);
  if (expires - created > (opts.maxLifetimeSeconds ?? WEB_BOT_AUTH_DEFAULT_MAX_LIFETIME_SECONDS)) return fail('lifetime_too_long', base);
  if (created > nowSec + skew) return fail('not_yet_valid', base);
  if (expires < nowSec - skew) return fail('expired', base);

  // Coverage: the signature must bind the host, and the directory claim it relies on.
  const names = input.components.map((c) => c.name);
  if (input.components.some((c) => Object.keys(c.params).length > 0)) return fail('unsupported_component', base);
  const agentHeader = headerValue(req.headers, 'signature-agent');
  if (agentHeader === undefined) return fail('missing_signature_agent', base);
  if (!names.includes('@authority') || !names.includes('signature-agent')) return fail('components_not_covered', base);
  const directory = parseSignatureAgent(agentHeader, input.label);
  if (!directory) return fail('bad_signature_agent', base);
  const withDir = { ...base, directory };

  const built = buildSignatureBase(req, names, input.raw);
  if ('error' in built) return fail(built.error, withDir);

  const dirUrl = directoryUrlFor(directory);
  const find = (keys: WebBotAuthJwk[] | null) => keys?.find((k) => ed25519JwkThumbprint(k) === keyId);
  let keys = await opts.getKeys(dirUrl, { refresh: false });
  let jwk = find(keys);
  if (!jwk) {
    keys = await opts.getKeys(dirUrl, { refresh: true });
    jwk = find(keys);
  }
  if (!jwk) return fail(keys === null ? 'directory_unavailable' : 'key_not_found', withDir);

  const pub = ed25519JwkBytes(jwk);
  let ok = false;
  try {
    ok = pub !== null && signature.length === 64 && ed25519.verify(signature, enc.encode(built.base), pub);
  } catch {
    ok = false;
  }
  if (!ok) return fail('bad_signature', withDir);

  if (opts.claimNonce && typeof nonce === 'string') {
    if (!(await opts.claimNonce(`${directory}|${keyId}|${nonce}`, expires * 1000 + skew * 1000))) return fail('replayed', withDir);
  }
  return { signed: true, verified: true, ...withDir, nonce: typeof nonce === 'string' ? nonce : null };
}

// ---------------------------------------------------------------------------
// Signing (for bots and tests)
// ---------------------------------------------------------------------------

export interface SignWebBotAuthInput {
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** The directory URL the bot publishes its keys under. */
  signatureAgent: string;
  /** The Ed25519 private key: the 32-byte seed. */
  privateKey: Uint8Array;
  created: number;
  expires: number;
  nonce?: string;
  label?: string;
  /** Covered components; must include @authority and signature-agent. Default those two. */
  components?: readonly string[];
}

/** Produce the three headers (`signature-agent`, `signature-input`, `signature`) for a request. */
export function signWebBotAuthRequest(input: SignWebBotAuthInput): Record<string, string> {
  const label = input.label ?? 'sig1';
  const components = input.components ?? ['@authority', 'signature-agent'];
  const pub = ed25519.getPublicKey(input.privateKey);
  const keyId = ed25519JwkThumbprint({ x: bytesToBase64Url(pub) });
  const agentHeader = `"${input.signatureAgent}"`;
  const params =
    `(${components.map((c) => `"${c}"`).join(' ')});created=${input.created};keyid="${keyId}";alg="ed25519";expires=${input.expires}` +
    `${input.nonce ? `;nonce="${input.nonce}"` : ''};tag="${WEB_BOT_AUTH_TAG}"`;
  const headers = { ...input.headers, 'signature-agent': agentHeader };
  const built = buildSignatureBase({ method: input.method, url: input.url, headers }, components, params);
  if ('error' in built) throw new Error(`Cannot sign: ${built.error}.`);
  const sig = ed25519.sign(enc.encode(built.base), input.privateKey);
  return {
    'signature-agent': agentHeader,
    'signature-input': `${label}=${params}`,
    signature: `${label}=:${bytesToBase64(sig)}:`,
  };
}

// ---------------------------------------------------------------------------
// Directory cache
// ---------------------------------------------------------------------------

export interface WebBotAuthDirectoryCacheOptions {
  /** Fetch and JSON-parse a directory document; null on any failure. */
  fetchJson: (url: string) => Promise<unknown | null>;
  /** How long a fetched directory is trusted. Default 10 minutes. */
  ttlMs?: number;
  /** How long a failed fetch is remembered. Default 1 minute. */
  failureTtlMs?: number;
  /** The least time between refreshes of one directory, so a bot cannot force a fetch per request. Default 1 minute. */
  refreshCooldownMs?: number;
  /** Most directories held. Default 1000. */
  maxEntries?: number;
  now?: () => number;
}

/** A small in-memory directory cache shared by the API and the local verifier. */
export class WebBotAuthDirectoryCache {
  private readonly entries = new Map<string, { keys: WebBotAuthJwk[] | null; at: number; fetchedAt: number }>();
  private readonly ttl: number;
  private readonly failureTtl: number;
  private readonly cooldown: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(private readonly opts: WebBotAuthDirectoryCacheOptions) {
    this.ttl = opts.ttlMs ?? 10 * 60_000;
    this.failureTtl = opts.failureTtlMs ?? 60_000;
    this.cooldown = opts.refreshCooldownMs ?? 60_000;
    this.max = opts.maxEntries ?? 1000;
    this.now = opts.now ?? Date.now;
  }

  /** The `getKeys` to hand to {@link verifyWebBotAuth}. */
  readonly getKeys = async (url: string, o: { refresh: boolean }): Promise<WebBotAuthJwk[] | null> => {
    const t = this.now();
    const hit = this.entries.get(url);
    const ttl = hit?.keys ? this.ttl : this.failureTtl;
    if (hit && t - hit.at < ttl && !(o.refresh && t - hit.fetchedAt >= this.cooldown)) return hit.keys;
    let keys: WebBotAuthJwk[] | null = null;
    try {
      const doc = await this.opts.fetchJson(url);
      const parsed = doc === null ? [] : parseDirectory(doc);
      keys = parsed.length > 0 ? parsed : null;
    } catch {
      keys = null;
    }
    // A failed refresh keeps serving the last good copy rather than dropping a working directory.
    const kept = keys ?? hit?.keys ?? null;
    if (this.entries.size >= this.max && !this.entries.has(url)) this.entries.delete(this.entries.keys().next().value as string);
    this.entries.set(url, { keys: kept, at: t, fetchedAt: t });
    return kept;
  };

  clear(): void {
    this.entries.clear();
  }
}

// ---------------------------------------------------------------------------
// Decision (allow and block lists)
// ---------------------------------------------------------------------------

export interface WebBotAuthListEntry {
  /** A directory URL or bare host. Normalised before comparing. */
  directory: string;
  /** A label for the agent (shown in decisions and logs). Defaults to the directory host. */
  name?: string;
}

export interface WebBotAuthPolicy {
  allow?: readonly WebBotAuthListEntry[];
  block?: readonly WebBotAuthListEntry[];
}

export type WebBotAuthDecisionKind = 'allow' | 'block' | 'unknown';
export type WebBotAuthTier = 'allowed' | 'blocked' | 'verified' | 'unverified';

export interface WebBotAuthDecision {
  verified: boolean;
  /** Who signed: set only when `verified`, because an unverified claim proves nothing. */
  agent: { directory: string; key_id: string; name: string } | null;
  tier: WebBotAuthTier;
  decision: WebBotAuthDecisionKind;
  /** Why verification failed (absent when verified). */
  reason?: WebBotAuthFailure;
}

/**
 * Turn a verification result into a decision. Only a VERIFIED directory can be
 * allowed or blocked: an unsigned or failed request is `unknown`, never trusted
 * and never attributed to the directory it claimed. A block entry beats an allow entry.
 */
export function decideWebBotAuth(result: WebBotAuthResult, policy: WebBotAuthPolicy = {}): WebBotAuthDecision {
  if (!result.verified || !result.directory || !result.keyId) {
    return { verified: false, agent: null, tier: 'unverified', decision: 'unknown', ...(result.reason ? { reason: result.reason } : {}) };
  }
  const match = (list?: readonly WebBotAuthListEntry[]) => list?.find((e) => normalizeDirectory(e.directory) === result.directory);
  const blocked = match(policy.block);
  const allowed = blocked ? undefined : match(policy.allow);
  const entry = blocked ?? allowed;
  const name = entry?.name?.trim() || new URL(result.directory).host;
  return {
    verified: true,
    agent: { directory: result.directory, key_id: result.keyId, name },
    tier: blocked ? 'blocked' : allowed ? 'allowed' : 'verified',
    decision: blocked ? 'block' : allowed ? 'allow' : 'unknown',
  };
}

// ---------------------------------------------------------------------------
// Local verifier
// ---------------------------------------------------------------------------

export interface WebBotAuthVerifierOptions extends WebBotAuthPolicy {
  /**
   * The fetch used for directories. Defaults to the global one with a 5 second
   * limit, https only, no redirects and a 64 KB cap. If your server can reach
   * private networks, pass a fetch that refuses private addresses.
   */
  fetch?: typeof fetch;
  ttlMs?: number;
  refreshCooldownMs?: number;
  skewSeconds?: number;
  maxLifetimeSeconds?: number;
  /** Refuse a signature whose nonce was seen before (in memory, per process). Off by default: some bots reuse one signed request until it expires. */
  rejectReplays?: boolean;
  now?: () => number;
}

const DIRECTORY_MAX_BYTES = 64 * 1024;

const isPrivateHostLiteral = (host: string): boolean => {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' || h.endsWith('.localhost') || h.includes(':') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || !h.includes('.')
  );
};

/** A verifier that runs inside your own server: no call to Atlas, directories cached in memory. */
export function createWebBotAuthVerifier(options: WebBotAuthVerifierOptions = {}) {
  const f = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const cache = new WebBotAuthDirectoryCache({
    ttlMs: options.ttlMs,
    refreshCooldownMs: options.refreshCooldownMs,
    now,
    fetchJson: async (url) => {
      const u = new URL(url);
      if (u.protocol !== 'https:' || isPrivateHostLiteral(u.hostname)) return null;
      const res = await f(url, {
        headers: { accept: WEB_BOT_AUTH_DIRECTORY_MEDIA_TYPE },
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const text = await res.text();
      if (text.length > DIRECTORY_MAX_BYTES) return null;
      return JSON.parse(text) as unknown;
    },
  });
  const seen = new Map<string, number>();
  const claimNonce = async (key: string, expiresAtMs: number): Promise<boolean> => {
    const t = now();
    if (seen.size > 5000) for (const [k, exp] of seen) if (exp <= t) seen.delete(k);
    if (seen.size > 20_000) return false; // fail closed rather than grow without bound
    const prior = seen.get(key);
    if (prior !== undefined && prior > t) return false;
    seen.set(key, expiresAtMs);
    return true;
  };

  return {
    /** Verify and decide. Never throws. */
    async verify(req: WebBotAuthRequest): Promise<WebBotAuthDecision> {
      const result = await verifyWebBotAuth(req, {
        getKeys: cache.getKeys,
        now: now(),
        skewSeconds: options.skewSeconds,
        maxLifetimeSeconds: options.maxLifetimeSeconds,
        claimNonce: options.rejectReplays ? claimNonce : undefined,
      });
      return decideWebBotAuth(result, { allow: options.allow, block: options.block });
    },
    clearCache: () => cache.clear(),
  };
}
