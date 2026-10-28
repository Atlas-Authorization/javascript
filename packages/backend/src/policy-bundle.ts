import { compactVerify, createLocalJWKSet, type JWK } from 'jose';

/**
 * Verify a signed policy bundle OFFLINE — no call to Atlas. This is what an edge
 * PDP, a CI job or an air-gapped service runs before it trusts a bundle:
 *
 *   1. the detached JWS over the archive bytes verifies against a public key you
 *      trust (the instance JWKS you fetched or pinned; RS256 / ES256 only),
 *   2. the archive is a well-formed tar.gz of bounded size with no unsafe paths,
 *   3. every file matches its SHA-256 in the manifest, nothing is added or
 *      missing, and the revision recomputed from the content equals the manifest's.
 *
 * Only if all three hold does it return the policies and models. Runs anywhere
 * with `fetch`-era Web APIs: Node 18+, Deno, Bun, edge workers (it uses
 * `DecompressionStream` and `crypto.subtle`).
 */

export type PolicyBundleErrorCode =
  | 'invalid_signature'
  | 'unknown_key'
  | 'invalid_archive'
  | 'invalid_manifest'
  | 'digest_mismatch'
  | 'unlisted_file'
  | 'missing_file'
  | 'revision_mismatch'
  | 'invalid_content'
  | 'unsupported_version'
  | 'unexpected_revision';

export class PolicyBundleError extends Error {
  constructor(
    readonly code: PolicyBundleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PolicyBundleError';
  }
}

export interface BundleAbacPolicy {
  name: string;
  description: string | null;
  enabled: boolean;
  /** The FGA store the policy's `fga.check(...)` consults, by name. */
  fga_store: string | null;
  source: string;
  tests: Array<{ name: string; request: Record<string, unknown>; expect: 'allow' | 'deny' }>;
}

export interface BundleFgaStore {
  name: string;
  model: { schema_version: string; type_definitions: unknown[]; conditions?: Record<string, unknown> } | null;
}

export interface BundleAbacTemplate {
  name: string;
  description: string | null;
  fga_store: string | null;
  /** Policy source with ?principal / ?resource slots. */
  source: string;
}

export interface BundleAbacLink {
  name: string;
  /** The template it fills, by name. */
  template: string;
  principal: { type: string; id: string } | null;
  resource: { type: string; id: string } | null;
  enabled: boolean;
}

export interface VerifiedPolicyBundle {
  revision: string;
  manifest: {
    format: string;
    format_version: number;
    revision: string;
    created_at: string;
    issuer: string | null;
    contents: { abac_policies: number; fga_stores: number; abac_templates?: number; abac_links?: number; abac_schema?: boolean };
    files: Array<{ path: string; sha256: string; size: number }>;
  };
  policies: BundleAbacPolicy[];
  fgaStores: BundleFgaStore[];
  /** The ABAC entity schema, or null when the bundle has none. */
  abacSchema: Record<string, unknown> | null;
  abacTemplates: BundleAbacTemplate[];
  abacLinks: BundleAbacLink[];
  /** The key id that signed it. */
  keyId: string | undefined;
  algorithm: string;
}

export interface VerifyPolicyBundleOptions {
  /** The tar.gz bytes, or the base64 the API returns. */
  bundle: Uint8Array | string;
  /** The detached JWS (`header..signature`). */
  signature: string;
  /** Public keys you trust: the instance JWKS (`/.well-known/jwks.json`), or the key array. */
  jwks: { keys: JWK[] } | JWK[];
  /** Refuse a bundle that is not exactly this revision (pin what you deployed). */
  expectedRevision?: string;
}

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 5000;
const TYP = 'atlas-policy-bundle+jws';
const BLOCK = 512;
const td = new TextDecoder('utf-8', { fatal: true });
const te = new TextEncoder();

const toBytes = (b: Uint8Array | string): Uint8Array => {
  if (typeof b !== 'string') return b;
  const bin = atob(b.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const b64url = (b: Uint8Array): string => btoa(Array.from(b, (c) => String.fromCharCode(c)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (b: ArrayBuffer): string => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (b: Uint8Array | string): Promise<string> => hex(await crypto.subtle.digest('SHA-256', typeof b === 'string' ? te.encode(b) : (b as Uint8Array<ArrayBuffer>)));

/** JSON with sorted keys and no whitespace — must match what the signer hashed. */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new PolicyBundleError('invalid_archive', 'The bundle expands beyond the allowed size.');
      }
      chunks.push(value);
    }
  } catch (err) {
    if (err instanceof PolicyBundleError) throw err;
    throw new PolicyBundleError('invalid_archive', 'The bundle is not a valid gzip archive.');
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function untar(tar: Uint8Array): Map<string, Uint8Array> {
  const bad = (m: string) => new PolicyBundleError('invalid_archive', m);
  const str = (h: Uint8Array, off: number, len: number) => {
    let end = off;
    while (end < off + len && h[end] !== 0) end++;
    try {
      return td.decode(h.subarray(off, end));
    } catch {
      throw bad('tar header is not valid UTF-8');
    }
  };
  const oct = (h: Uint8Array, off: number, len: number) => {
    const s = str(h, off, len).trim();
    if (!/^[0-7]+$/.test(s)) throw bad('malformed numeric field in tar header');
    return parseInt(s, 8);
  };
  const files = new Map<string, Uint8Array>();
  let off = 0;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) return files;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]!;
    if (oct(h, 148, 8) !== sum) throw bad('tar header checksum mismatch');
    if (h[156] !== 0x30 && h[156] !== 0) throw bad('tar contains an entry that is not a regular file');
    const path = str(h, 0, 100);
    if (!path || path.startsWith('/') || path.includes('\\') || path.split('/').some((p) => p === '' || p === '.' || p === '..')) {
      throw bad(`unsafe path in archive: '${path.slice(0, 60)}'`);
    }
    if (files.has(path)) throw bad(`duplicate path in archive: '${path}'`);
    if (files.size + 1 > MAX_FILES) throw bad('archive has too many files');
    const size = oct(h, 124, 12);
    off += BLOCK;
    if (off + size > tar.length) throw bad('tar is truncated');
    files.set(path, tar.slice(off, off + size));
    off += Math.ceil(size / BLOCK) * BLOCK;
  }
  throw bad('tar is missing its end marker');
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function readPolicy(v: unknown, path: string): BundleAbacPolicy {
  const bad = (why: string) => new PolicyBundleError('invalid_content', `${path}: ${why}`);
  if (!isObj(v) || typeof v.name !== 'string' || !v.name) throw bad('a policy needs a name');
  if (typeof v.source !== 'string') throw bad('source must be a string');
  if (typeof v.enabled !== 'boolean') throw bad('enabled must be a boolean');
  if (v.description !== null && typeof v.description !== 'string') throw bad('description must be a string or null');
  if (v.fga_store !== null && typeof v.fga_store !== 'string') throw bad('fga_store must be a store name or null');
  if (!Array.isArray(v.tests)) throw bad('tests must be an array');
  return v as unknown as BundleAbacPolicy;
}

function readStore(v: unknown, path: string): BundleFgaStore {
  const bad = (why: string) => new PolicyBundleError('invalid_content', `${path}: ${why}`);
  if (!isObj(v) || typeof v.name !== 'string' || !v.name) throw bad('a store needs a name');
  if (v.model !== null && (!isObj(v.model) || !Array.isArray(v.model.type_definitions) || typeof v.model.schema_version !== 'string')) {
    throw bad('model must be null or { schema_version, type_definitions }');
  }
  return v as unknown as BundleFgaStore;
}

function readTemplate(v: unknown, path: string): BundleAbacTemplate {
  const bad = (why: string) => new PolicyBundleError('invalid_content', `${path}: ${why}`);
  if (!isObj(v) || typeof v.name !== 'string' || !v.name) throw bad('a template needs a name');
  if (typeof v.source !== 'string') throw bad('source must be a string');
  if (v.description !== null && typeof v.description !== 'string') throw bad('description must be a string or null');
  if (v.fga_store !== null && typeof v.fga_store !== 'string') throw bad('fga_store must be a store name or null');
  return v as unknown as BundleAbacTemplate;
}

function readLink(v: unknown, path: string): BundleAbacLink {
  const bad = (why: string) => new PolicyBundleError('invalid_content', `${path}: ${why}`);
  const entity = (e: unknown) => e === null || (isObj(e) && typeof e.type === 'string' && !!e.type && typeof e.id === 'string' && !!e.id);
  if (!isObj(v) || typeof v.name !== 'string' || !v.name) throw bad('a link needs a name');
  if (typeof v.template !== 'string' || !v.template) throw bad('template must be a template name');
  if (typeof v.enabled !== 'boolean') throw bad('enabled must be a boolean');
  if (!entity(v.principal) || !entity(v.resource)) throw bad('principal and resource must be null or { type, id }');
  return v as unknown as BundleAbacLink;
}

const byName = <T extends { name: string }>(xs: T[]) => [...xs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/**
 * Verify and open a signed policy bundle. Throws {@link PolicyBundleError} with a
 * stable `code` on any failure; returns the content only when everything checks out.
 */
export async function verifyPolicyBundle(opts: VerifyPolicyBundleOptions): Promise<VerifiedPolicyBundle> {
  const archive = toBytes(opts.bundle);
  if (archive.length > MAX_BYTES) throw new PolicyBundleError('invalid_archive', 'The bundle is too large.');

  // 1. authenticity: the detached JWS over the archive bytes.
  const parts = opts.signature.split('.');
  if (parts.length !== 3 || parts[1] !== '' || !parts[0] || !parts[2]) {
    throw new PolicyBundleError('invalid_signature', 'The signature must be a detached compact JWS ("header..signature").');
  }
  const keys = Array.isArray(opts.jwks) ? opts.jwks : opts.jwks.keys;
  let header: { kid?: string; alg?: string; typ?: string };
  try {
    header = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/'))) as typeof header;
  } catch {
    throw new PolicyBundleError('invalid_signature', 'The signature header is not valid.');
  }
  if (header.kid && !keys.some((k) => k.kid === header.kid)) {
    throw new PolicyBundleError('unknown_key', `The bundle was signed with key ${header.kid}, which is not in the trusted keys.`);
  }
  try {
    const { protectedHeader } = await compactVerify(`${parts[0]}.${b64url(archive)}.${parts[2]}`, createLocalJWKSet({ keys }), {
      algorithms: ['RS256', 'ES256'],
    });
    if (protectedHeader.typ !== TYP) throw new Error('not a policy-bundle signature');
  } catch (err) {
    throw new PolicyBundleError('invalid_signature', `The bundle's signature does not verify: ${err instanceof Error ? err.message : 'failed'}.`);
  }

  // 2 + 3. integrity.
  const files = untar(await gunzip(archive));
  const manifestBytes = files.get('manifest.json');
  if (!manifestBytes) throw new PolicyBundleError('invalid_manifest', 'The bundle has no manifest.json.');
  let manifest: VerifiedPolicyBundle['manifest'];
  try {
    manifest = JSON.parse(td.decode(manifestBytes));
  } catch {
    throw new PolicyBundleError('invalid_manifest', 'manifest.json is not valid JSON.');
  }
  if (!isObj(manifest) || manifest.format !== 'atlas.policy-bundle' || !Array.isArray(manifest.files) || typeof manifest.revision !== 'string') {
    throw new PolicyBundleError('invalid_manifest', 'manifest.json is not an Atlas policy bundle manifest.');
  }
  if (manifest.format_version !== 1) throw new PolicyBundleError('unsupported_version', `Unsupported bundle format_version ${String(manifest.format_version)}.`);
  files.delete('manifest.json');
  const listed = new Set<string>();
  for (const f of manifest.files) {
    if (!isObj(f) || typeof f.path !== 'string' || typeof f.sha256 !== 'string') throw new PolicyBundleError('invalid_manifest', 'manifest.json has a malformed file entry.');
    if (listed.has(f.path)) throw new PolicyBundleError('invalid_manifest', `manifest.json lists ${f.path} twice.`);
    listed.add(f.path);
    const data = files.get(f.path);
    if (!data) throw new PolicyBundleError('missing_file', `${f.path} is listed in the manifest but missing from the archive.`);
    if ((await sha256(data)) !== f.sha256) throw new PolicyBundleError('digest_mismatch', `${f.path} does not match its digest in the manifest.`);
  }
  for (const p of files.keys()) {
    if (!listed.has(p)) throw new PolicyBundleError('unlisted_file', `${p} is in the archive but not in the manifest.`);
  }
  const policies: BundleAbacPolicy[] = [];
  const fgaStores: BundleFgaStore[] = [];
  const templates: BundleAbacTemplate[] = [];
  const links: BundleAbacLink[] = [];
  let schema: Record<string, unknown> | null = null;
  for (const [path, data] of files) {
    let json: unknown;
    try {
      json = JSON.parse(td.decode(data));
    } catch {
      throw new PolicyBundleError('invalid_content', `${path} is not valid JSON.`);
    }
    if (path.startsWith('abac/policies/')) policies.push(readPolicy(json, path));
    else if (path.startsWith('fga/stores/')) fgaStores.push(readStore(json, path));
    else if (path === 'abac/schema.json') {
      if (!isObj(json)) throw new PolicyBundleError('invalid_content', `${path}: the schema must be an object.`);
      schema = json;
    } else if (path.startsWith('abac/templates/')) templates.push(readTemplate(json, path));
    else if (path.startsWith('abac/links/')) links.push(readLink(json, path));
    else throw new PolicyBundleError('invalid_content', `${path} is not a recognised bundle file.`);
  }
  // Same normal form as the server: empty template/link lists and a missing schema are left out.
  const normal = {
    abac_policies: byName(policies),
    fga_stores: byName(fgaStores),
    ...(schema ? { abac_schema: schema } : {}),
    ...(templates.length ? { abac_templates: byName(templates) } : {}),
    ...(links.length ? { abac_links: byName(links) } : {}),
  };
  const recomputed = `rev_${(await sha256(canonicalJson(normal))).slice(0, 32)}`;
  if (recomputed !== manifest.revision) throw new PolicyBundleError('revision_mismatch', "The bundle's content does not match the revision in its manifest.");
  if (opts.expectedRevision && opts.expectedRevision !== manifest.revision) {
    throw new PolicyBundleError('unexpected_revision', `Expected revision ${opts.expectedRevision} but the bundle is ${manifest.revision}.`);
  }
  return { revision: manifest.revision, manifest, policies: byName(policies), fgaStores: byName(fgaStores), abacSchema: schema, abacTemplates: byName(templates), abacLinks: byName(links), keyId: header.kid, algorithm: header.alg ?? '' };
}
