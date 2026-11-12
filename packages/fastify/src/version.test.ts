import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ATLAS_FASTIFY_VERSION } from './version';

describe('version', () => {
  it('matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(ATLAS_FASTIFY_VERSION).toBe(pkg.version);
  });
});
