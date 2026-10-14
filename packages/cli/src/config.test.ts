import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileConfigStore, defaultConfigPath } from './config';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atlas-cli-cfg-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('FileConfigStore', () => {
  it('returns an empty config when the file does not exist', () => {
    const store = new FileConfigStore(join(dir, 'nope', 'config.json'));
    expect(store.load()).toEqual({ profiles: {} });
  });

  it('round-trips a saved config and writes it 0600', () => {
    const path = join(dir, 'nested', 'config.json');
    const store = new FileConfigStore(path);
    store.save({ active_profile: 'default', profiles: { default: { api_url: 'https://x', secret_key: 'sk_1' } } });

    expect(store.load()).toEqual({
      active_profile: 'default',
      profiles: { default: { api_url: 'https://x', secret_key: 'sk_1' } },
    });

    // The mode low bits must be exactly 0600 — nobody else can read the key.
    // Windows has no POSIX permission bits (stat reports 0666), so only check them elsewhere.
    if (process.platform !== 'win32') {
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });

  it('throws a clean error on a corrupt file', () => {
    const path = join(dir, 'config.json');
    const store = new FileConfigStore(path);
    writeFileSync(path, '{not json', 'utf8');
    expect(() => store.load()).toThrow(/not valid JSON/);
  });
});

describe('defaultConfigPath', () => {
  it('honors XDG_CONFIG_HOME', () => {
    expect(defaultConfigPath({ XDG_CONFIG_HOME: '/xdg' } as NodeJS.ProcessEnv)).toBe(
      join('/xdg', 'atlasauth', 'config.json'),
    );
  });
  it('falls back to ~/.config', () => {
    expect(defaultConfigPath({} as NodeJS.ProcessEnv)).toBe(
      join(homedir(), '.config', 'atlasauth', 'config.json'),
    );
  });
});
