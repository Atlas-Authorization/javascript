import { describe, expect, it } from 'vitest';
import * as pca from '@atlasauth/pca';
import { defaultExtract, memoryPcaStore, requirePCA, verifyPCActn } from './pca-entry';

/** The PCA verifier and guard are the published, hardened @atlasauth/pca ones (no local copy to drift). */
describe('Proof-Carrying Authority exports', () => {
  it('the main entry never loads @atlasauth/pca (it has Node-only attestation code; the main entry must stay Edge-safe)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    expect(readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8')).not.toContain('@atlasauth/pca');
  });

  it('re-exports the @atlasauth/pca implementation', () => {
    expect(verifyPCActn).toBe(pca.verifyPCActn);
    expect(requirePCA).toBe(pca.requirePCA);
    expect(defaultExtract).toBe(pca.defaultExtract);
    expect(memoryPcaStore).toBe(pca.memoryPcaStore);
  });

  it('fails closed on garbage and on a request without a PCActn', async () => {
    const v = await verifyPCActn('not a pcactn', { grant: {} as never });
    expect(v.allow).toBe(false);
    const guard = requirePCA({ audience: 'ins_1', resolveGrant: async () => null });
    const res = await guard({ headers: {} });
    expect(res.ok).toBe(false);
  });
});
