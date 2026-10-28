import { describe, expect, it } from 'vitest';
import type { MigrationEntry } from './schema';
import {
  BundleError,
  BundleOpener,
  BundleSealer,
  LineSplitter,
  MIGRATION_PROFILE,
  TRANSPORT_ALG,
  generateImportKeyPair,
  openBundleText,
  parseBundleHeader,
  parseImportPublicKey,
  peekBundleFormat,
  type BundleProfile,
} from './transport';

const keys = generateImportKeyPair();
const recipient = { kid: 'imk_test', publicKey: keys.publicKey };

const entries: MigrationEntry[] = [
  {
    type: 'manifest',
    format: 'atlas-migration-bundle',
    formatVersion: 1,
    source: 'auth0',
    exportedAt: '2026-10-25T00:00:00.000Z',
    exporter: { name: 'test', version: '0.0.0' },
    warnings: [],
  },
  { type: 'record', model: 'user', data: { id: 'auth0|1', emails: [{ email: 'a@example.com', verified: true }], password: { algorithm: 'bcrypt', hash: '$2b$10$secret' } } },
  { type: 'record', model: 'user', data: { id: 'auth0|2', username: 'ü-ser ✓' } },
  { type: 'end', counts: { user: 2 }, omitted: {} },
];

async function seal(list: unknown[] = entries, options: { chunkBytes?: number; profile?: BundleProfile<unknown> } = {}) {
  const lines: string[] = [];
  const sealer = new BundleSealer<unknown>(recipient, (l) => void lines.push(l), options);
  for (const e of list) await sealer.add(e);
  const chunks = await sealer.finish();
  return { lines, chunks, text: `${lines.join('\n')}\n` };
}

const codeOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof BundleError ? e.code : `not a BundleError: ${String(e)}`;
  }
};

describe('seal → open', () => {
  it('round-trips the entries in one chunk', async () => {
    const { lines, chunks, text } = await seal();
    expect(chunks).toBe(1);
    expect(lines).toHaveLength(2);
    const header = JSON.parse(lines[0]!);
    expect(header).toMatchObject({ format: 'atlas-migration-bundle', v: 1, alg: TRANSPORT_ALG, kid: 'imk_test' });
    expect(openBundleText(text, keys.privateKeyJwk)).toEqual(entries);
  });

  it('never writes the plaintext', async () => {
    const { text } = await seal();
    expect(text).not.toContain('secret');
    expect(text).not.toContain('a@example.com');
  });

  it('round-trips across many chunks, fed line by line', async () => {
    const { lines, chunks } = await seal(entries, { chunkBytes: 1 });
    expect(chunks).toBe(entries.length);
    const opener = new BundleOpener(keys.privateKeyJwk);
    const out: unknown[] = [];
    for (const l of lines) out.push(...opener.push(l));
    opener.end();
    expect(out).toEqual(entries);
    expect(opener.kid).toBe('imk_test');
    expect(opener.chunks).toBe(entries.length);
  });

  it('an empty bundle (finish only) still opens', async () => {
    const { text, chunks } = await seal([]);
    expect(chunks).toBe(1);
    expect(openBundleText(text, keys.privateKeyJwk)).toEqual([]);
  });

  it('every bundle has a fresh ephemeral key and nonce prefix', async () => {
    const a = JSON.parse((await seal()).lines[0]!);
    const b = JSON.parse((await seal()).lines[0]!);
    expect(a.epk).not.toBe(b.epk);
    expect(a.np).not.toBe(b.np);
  });
});

describe('refusals', () => {
  it('another instance key does not open it', async () => {
    const { text } = await seal();
    expect(codeOf(() => openBundleText(text, generateImportKeyPair().privateKeyJwk))).toBe('bundle_wrong_key');
  });

  it('a modified chunk, a reordered or truncated bundle and trailing data are refused', async () => {
    const { lines } = await seal(entries, { chunkBytes: 1 });
    const open = (ls: string[]) => codeOf(() => openBundleText(`${ls.join('\n')}\n`, keys.privateKeyJwk));

    const flipped = [...lines];
    const c = flipped[2]!;
    flipped[2] = c.slice(0, 5) + (c[5] === 'A' ? 'B' : 'A') + c.slice(6);
    expect(open(flipped)).toBe('bundle_tampered');

    const swapped = [lines[0]!, lines[1]!, lines[3]!, lines[2]!, ...lines.slice(4)];
    expect(open(swapped)).toBe('bundle_tampered');

    expect(open(lines.slice(0, -1))).toBe('bundle_truncated');
    expect(open([...lines, lines[2]!])).toBe('bundle_tampered');
  });

  it('a modified header (key id) breaks the first chunk', async () => {
    const { lines } = await seal();
    const header = JSON.parse(lines[0]!);
    const forged = [JSON.stringify({ ...header, kid: 'imk_other' }), lines[1]!];
    expect(codeOf(() => openBundleText(`${forged.join('\n')}\n`, keys.privateKeyJwk))).toBe('bundle_wrong_key');
  });

  it('the Better Auth format does not open as a migration bundle, nor a different HKDF info', async () => {
    const betterAuth: BundleProfile<unknown> = {
      format: 'atlas-better-auth-bundle',
      version: 1,
      hkdfInfo: 'atlas better-auth bundle v1',
      label: 'Better Auth bundle',
      parseEntry: (e) => e,
    };
    const ba = await seal(entries, { profile: betterAuth });
    expect(peekBundleFormat(ba.lines[0]!)).toBe('atlas-better-auth-bundle');
    expect(codeOf(() => openBundleText(ba.text, keys.privateKeyJwk))).toBe('bundle_malformed');
    // Same format id, other HKDF info: the key differs, so nothing decrypts.
    const otherInfo = { ...betterAuth, format: MIGRATION_PROFILE.format, hkdfInfo: 'atlas better-auth bundle v1' };
    const sealed = await seal(entries, { profile: otherInfo });
    expect(codeOf(() => openBundleText(sealed.text, keys.privateKeyJwk))).toBe('bundle_wrong_key');
    expect(openBundleText(sealed.text, keys.privateKeyJwk, otherInfo)).toEqual(entries);
  });

  it('checks the header before decrypting anything', () => {
    const good = { format: 'atlas-migration-bundle', v: 1, alg: TRANSPORT_ALG, kid: 'k', epk: Buffer.alloc(32, 9).toString('base64url'), np: Buffer.alloc(7).toString('base64url') };
    expect(parseBundleHeader(JSON.stringify(good)).kid).toBe('k');
    expect(codeOf(() => parseBundleHeader('not json'))).toBe('bundle_malformed');
    expect(codeOf(() => parseBundleHeader(JSON.stringify({ ...good, format: 'other' })))).toBe('bundle_malformed');
    expect(codeOf(() => parseBundleHeader(JSON.stringify({ ...good, v: 2 })))).toBe('bundle_unsupported');
    expect(codeOf(() => parseBundleHeader(JSON.stringify({ ...good, alg: 'RSA-OAEP' })))).toBe('bundle_unsupported');
    expect(codeOf(() => parseBundleHeader(JSON.stringify({ ...good, kid: '' })))).toBe('bundle_malformed');
    expect(codeOf(() => parseBundleHeader(JSON.stringify({ ...good, np: 'AA' })))).toBe('bundle_malformed');
    expect(peekBundleFormat('nope')).toBeNull();
  });

  it('an empty file and entries of unknown type are refused', async () => {
    expect(codeOf(() => openBundleText('', keys.privateKeyJwk))).toBe('bundle_malformed');
    const { text } = await seal([{ type: 'surprise' }]);
    expect(codeOf(() => openBundleText(text, keys.privateKeyJwk))).toBe('bundle_malformed');
    const noData = await seal([{ type: 'record', model: 'user' }]);
    expect(codeOf(() => openBundleText(noData.text, keys.privateKeyJwk))).toBe('bundle_malformed');
    const badManifest = await seal([{ type: 'manifest', format: 'x', source: 'auth0' }]);
    expect(codeOf(() => openBundleText(badManifest.text, keys.privateKeyJwk))).toBe('bundle_malformed');
  });

  it('passes a record of a model this reader does not know through (the importer skips it)', async () => {
    const future = { type: 'record', model: 'audit_log', data: { id: 'x' } };
    const { text } = await seal([future]);
    expect(openBundleText(text, keys.privateKeyJwk)).toEqual([future]);
  });

  it('refuses adding after finish', async () => {
    const sealer = new BundleSealer(recipient, () => undefined);
    await sealer.finish();
    await expect(sealer.add(entries[0]!)).rejects.toThrow(/finished/);
  });
});

describe('import keys', () => {
  it('parses every shape Atlas prints', () => {
    const want = { kid: 'imk_1', publicKey: keys.publicKey };
    expect(parseImportPublicKey({ kid: 'imk_1', public_key: keys.publicKey })).toEqual(want);
    expect(parseImportPublicKey({ kid: ' imk_1 ', publicKey: keys.publicKey })).toEqual(want);
    expect(parseImportPublicKey(`imk_1:${keys.publicKey}`)).toEqual(want);
  });

  it('refuses a key without kid or of the wrong length', () => {
    expect(() => parseImportPublicKey({ publicKey: keys.publicKey })).toThrow(/kid/);
    expect(() => parseImportPublicKey({ kid: 'k', publicKey: 'AAAA' })).toThrow(/32-byte/);
    expect(() => parseImportPublicKey('no-colon')).toThrow();
    expect(() => parseImportPublicKey(null)).toThrow();
  });
});

describe('LineSplitter', () => {
  it('reassembles lines split across parts', () => {
    const s = new LineSplitter();
    expect(s.push('ab')).toEqual([]);
    expect(s.push('c\nde')).toEqual(['abc']);
    expect(s.push('f\n\ng')).toEqual(['def', '']);
    expect(s.flush()).toEqual(['g']);
    expect(s.flush()).toEqual([]);
  });
});
