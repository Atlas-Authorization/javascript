import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCodeConfig } from './config';

describe('atlas.config.ts / .mjs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'atlas-code-config-'));

  it('loads a TypeScript default export (Node type stripping)', async () => {
    const f = join(dir, 'atlas.config.ts');
    writeFileSync(f, "type C = { webhooks: Array<{ url: string }> };\nconst c: C = { webhooks: [{ url: 'https://example.com/hook' }] };\nexport default c;\n");
    expect(await loadCodeConfig(f)).toEqual({ webhooks: [{ url: 'https://example.com/hook' }] });
  });

  it('calls an exported (async) function', async () => {
    const f = join(dir, 'atlas.config.mjs');
    writeFileSync(f, "export default async () => ({ instance: { name: 'x' } });\n");
    expect(await loadCodeConfig(f)).toEqual({ instance: { name: 'x' } });
  });

  it('refuses a file with no default export', async () => {
    const f = join(dir, 'empty.config.mjs');
    writeFileSync(f, 'export const x = 1;\n');
    await expect(loadCodeConfig(f)).rejects.toThrow(/no default export/);
  });
});
