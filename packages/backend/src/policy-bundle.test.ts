import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { CompactSign, SignJWT, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { PolicyBundleError, verifyPolicyBundle } from './policy-bundle';

/**
 * A self-contained signer: builds a bundle byte-for-byte in the documented layout
 * (so this suite needs no server) and signs it as a detached JWS.
 */
const te = new TextEncoder();
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const canon = (v: unknown): string =>
  v === null || typeof v !== 'object'
    ? (JSON.stringify(v) ?? 'null')
    : Array.isArray(v)
      ? `[${v.map(canon).join(',')}]`
      : `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;

function tar(entries: Array<{ path: string; data: Uint8Array }>): Uint8Array {
  const out: Uint8Array[] = [];
  for (const e of entries) {
    const h = new Uint8Array(512);
    const put = (off: number, s: string) => h.set(te.encode(s), off);
    put(0, e.path);
    put(100, '0000644\0');
    put(108, '0000000\0');
    put(116, '0000000\0');
    put(124, e.data.length.toString(8).padStart(11, '0') + '\0');
    put(136, '00000000000\0');
    h.fill(0x20, 148, 156);
    h[156] = 0x30;
    put(257, 'ustar\0');
    put(263, '00');
    let sum = 0;
    for (const b of h) sum += b;
    put(148, sum.toString(8).padStart(6, '0') + '\0 ');
    out.push(h, e.data, new Uint8Array((512 - (e.data.length % 512)) % 512));
  }
  out.push(new Uint8Array(1024));
  return Buffer.concat(out);
}

const policy = { name: 'docs', description: null, enabled: true, fga_store: null, source: 'permit(principal, action, resource);', tests: [] };
const store = { name: 'main', model: { schema_version: '1.1', type_definitions: [{ type: 'user' }] } };

let priv: KeyLike;
let jwks: { keys: JWK[] };
beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
  priv = privateKey;
  jwks = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' }] };
});

async function make(over: { policies?: unknown[]; stores?: unknown[]; mutate?: (f: Array<{ path: string; data: Uint8Array }>, manifest: Record<string, unknown>) => void } = {}) {
  const policies = over.policies ?? [policy];
  const stores = over.stores ?? [store];
  const files = [
    ...policies.map((p, i) => ({ path: `abac/policies/p${i}.json`, data: te.encode(canon(p)) })),
    ...stores.map((s, i) => ({ path: `fga/stores/s${i}.json`, data: te.encode(canon(s)) })),
  ];
  const revision = `rev_${sha(canon({ abac_policies: policies, fga_stores: stores })).slice(0, 32)}`;
  const manifest: Record<string, unknown> = {
    format: 'atlas.policy-bundle',
    format_version: 1,
    revision,
    created_at: '2026-01-01T00:00:00.000Z',
    issuer: null,
    contents: { abac_policies: policies.length, fga_stores: stores.length },
    files: files.map((f) => ({ path: f.path, sha256: sha(f.data), size: f.data.length })),
  };
  over.mutate?.(files, manifest);
  const archive = new Uint8Array(gzipSync(tar([{ path: 'manifest.json', data: te.encode(JSON.stringify(manifest)) }, ...files])));
  const jws = await new CompactSign(archive).setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'atlas-policy-bundle+jws', cty: 'application/gzip' }).sign(priv);
  const [h, , s] = jws.split('.');
  return { archive, signature: `${h}..${s}`, revision };
}

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof PolicyBundleError ? e.code : `other:${String(e)}`;
  }
  return 'no error';
};

describe('verifyPolicyBundle', () => {
  it('opens a good bundle (bytes or base64) and returns its content', async () => {
    const b = await make();
    const ok = await verifyPolicyBundle({ bundle: b.archive, signature: b.signature, jwks, expectedRevision: b.revision });
    expect(ok).toMatchObject({ revision: b.revision, keyId: 'k1', algorithm: 'ES256' });
    expect(ok.policies).toEqual([policy]);
    expect(ok.fgaStores).toEqual([store]);
    const viaB64 = await verifyPolicyBundle({ bundle: Buffer.from(b.archive).toString('base64'), signature: b.signature, jwks: jwks.keys });
    expect(viaB64.revision).toBe(b.revision);
  });

  it('rejects a flipped byte, a foreign key, a bad header and a swapped signature', async () => {
    const b = await make();
    const flipped = Buffer.from(b.archive);
    flipped[20] = flipped[20]! ^ 1;
    expect(await codeOf(verifyPolicyBundle({ bundle: flipped, signature: b.signature, jwks }))).toBe('invalid_signature');
    const other = await generateKeyPair('ES256', { extractable: true });
    const stranger = { keys: [{ ...(await exportJWK(other.publicKey)), kid: 'k1', alg: 'ES256' }] };
    expect(await codeOf(verifyPolicyBundle({ bundle: b.archive, signature: b.signature, jwks: stranger }))).toBe('invalid_signature');
    expect(await codeOf(verifyPolicyBundle({ bundle: b.archive, signature: b.signature, jwks: { keys: [] } }))).toBe('unknown_key');
    expect(await codeOf(verifyPolicyBundle({ bundle: b.archive, signature: 'x', jwks }))).toBe('invalid_signature');
    const attached = await new CompactSign(b.archive).setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'atlas-policy-bundle+jws' }).sign(priv);
    expect(await codeOf(verifyPolicyBundle({ bundle: b.archive, signature: attached, jwks }))).toBe('invalid_signature');
    const wrongTyp = (await new CompactSign(b.archive).setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'JWT' }).sign(priv)).replace(/\.[^.]+\./, '..');
    expect(await codeOf(verifyPolicyBundle({ bundle: b.archive, signature: wrongTyp, jwks }))).toBe('invalid_signature');
  });

  it('rejects an HS256 / none style downgrade', async () => {
    const b = await make();
    const hs = await new SignJWT({}).setProtectedHeader({ alg: 'HS256', kid: 'k1' }).sign(new Uint8Array(32));
    const [h, , s] = hs.split('.');
    expect(await codeOf(verifyPolicyBundle({ bundle: b.archive, signature: `${h}..${s}`, jwks }))).toBe('invalid_signature');
  });

  it('refuses a correctly signed archive that is internally inconsistent', async () => {
    const sign = async (m: Parameters<typeof make>[0]) => {
      const b = await make(m);
      return codeOf(verifyPolicyBundle({ bundle: b.archive, signature: b.signature, jwks }));
    };
    expect(await sign({ mutate: (f) => { f[0]!.data = te.encode('{"name":"docs"}'); } })).toBe('digest_mismatch');
    expect(await sign({ mutate: (f) => { f.push({ path: 'abac/policies/extra.json', data: te.encode('{}') }); } })).toBe('unlisted_file');
    expect(await sign({ mutate: (f) => { f.pop(); } })).toBe('missing_file');
    expect(await sign({ mutate: (_f, m) => { m.revision = 'rev_forged'; } })).toBe('revision_mismatch');
    expect(await sign({ mutate: (_f, m) => { m.format_version = 2; } })).toBe('unsupported_version');
    expect(await sign({ mutate: (_f, m) => { m.format = 'something.else'; } })).toBe('invalid_manifest');
    expect(await sign({ mutate: (f, m) => { f[0]!.data = te.encode('not json'); (m.files as Array<{ path: string; sha256: string }>)[0]!.sha256 = sha(f[0]!.data); } })).toBe('invalid_content');
  });

  it('refuses a gzip bomb and a non-gzip body', async () => {
    const bomb = new Uint8Array(gzipSync(tar([{ path: 'manifest.json', data: new Uint8Array(40 * 1024 * 1024) }])));
    const sig = (await new CompactSign(bomb).setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'atlas-policy-bundle+jws' }).sign(priv)).replace(/\.[^.]+\./, '..');
    expect(await codeOf(verifyPolicyBundle({ bundle: bomb, signature: sig, jwks }))).toBe('invalid_archive');
    const junk = te.encode('not a bundle');
    const jsig = (await new CompactSign(junk).setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'atlas-policy-bundle+jws' }).sign(priv)).replace(/\.[^.]+\./, '..');
    expect(await codeOf(verifyPolicyBundle({ bundle: junk, signature: jsig, jwks }))).toBe('invalid_archive');
  });

  it('refuses a path-traversing entry', async () => {
    const b = await make({ mutate: (f, m) => { f[0]!.path = '../evil.json'; (m.files as Array<{ path: string }>)[0]!.path = '../evil.json'; } });
    expect(await codeOf(verifyPolicyBundle({ bundle: b.archive, signature: b.signature, jwks }))).toBe('invalid_archive');
  });

  it('pins an expected revision', async () => {
    const b = await make();
    expect(await codeOf(verifyPolicyBundle({ bundle: b.archive, signature: b.signature, jwks, expectedRevision: 'rev_nope' }))).toBe('unexpected_revision');
  });
});
