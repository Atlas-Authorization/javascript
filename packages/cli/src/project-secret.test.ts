import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { instanceSecretFromFile, type ProjectInstance } from './project';

const dir = mkdtempSync(join(tmpdir(), 'atlas-project-secret-'));
const base = (over: Partial<ProjectInstance>): ProjectInstance => ({
  instance_id: 'ins_1',
  environment: 'production',
  publishable_key: 'pk_test',
  frontend_api_host: null,
  issuer: null,
  discovery_url: null,
  jwks_uri: null,
  secret_file: join(dir, 'production.env'),
  ...over,
});
writeFileSync(join(dir, 'production.env'), 'ATLAS_SECRET_KEY=sk_runtime\n');
writeFileSync(join(dir, 'production-provisioning.env'), 'ATLAS_PROVISIONING_KEY=sk_provisioning\n');

describe('instanceSecretFromFile', () => {
  it('uses the provisioning key when init minted one, the app key otherwise', () => {
    expect(instanceSecretFromFile(base({ provisioning_file: join(dir, 'production-provisioning.env') }))).toBe('sk_provisioning');
    expect(instanceSecretFromFile(base({}))).toBe('sk_runtime');
    expect(instanceSecretFromFile(base({ provisioning_file: join(dir, 'missing.env') }))).toBe('sk_runtime');
  });
});
