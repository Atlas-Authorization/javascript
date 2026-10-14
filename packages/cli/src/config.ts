import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { CliError } from './errors';

/**
 * One stored instance credential. The secret key sits on disk in plaintext —
 * the same trade-off `auth0-cli` and the `gh` CLI make: a long-lived token in a
 * 0600 file under the user's home, not an OS keychain. {@link FileConfigStore}
 * enforces the 0600 so another user on the box cannot read it.
 */
export interface Profile {
  api_url: string;
  secret_key: string;
}

/** The whole config file: named profiles plus which one is active. */
export interface ConfigFile {
  active_profile?: string;
  profiles: Record<string, Profile>;
}

/**
 * The persistence seam. Commands depend on this interface, never on `fs`, so a
 * test injects a store backed by a temp path (or memory) and the real
 * `~/.config/...` file is never touched.
 */
export interface ConfigStore {
  /** Where this store reads/writes — surfaced for `login`'s success message. */
  readonly path: string;
  load(): ConfigFile;
  save(config: ConfigFile): void;
}

const EMPTY: ConfigFile = { profiles: {} };

/**
 * Resolve the default config path: `$XDG_CONFIG_HOME/atlasauth/config.json`,
 * falling back to `~/.config/atlasauth/config.json`. Honoring XDG keeps the CLI
 * a good citizen on Linux while still working on macOS, where `~/.config` is
 * the de-facto convention CLIs use.
 */
export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(base, 'atlasauth', 'config.json');
}

/** The real store: a JSON file written with 0600 perms and a 0700 parent dir. */
export class FileConfigStore implements ConfigStore {
  constructor(readonly path: string) {}

  load(): ConfigFile {
    let text: string;
    try {
      text = readFileSync(this.path, 'utf8');
    } catch {
      // Missing file is the first-run state, not an error.
      return { profiles: {} };
    }
    try {
      const parsed = JSON.parse(text) as ConfigFile;
      // Guard against a hand-corrupted file so every later `.profiles[...]` is safe.
      return { active_profile: parsed.active_profile, profiles: parsed.profiles ?? {} };
    } catch {
      throw new CliError(
        `Config file at ${this.path} is not valid JSON. Fix or remove it, then run 'atlas login' again.`,
      );
    }
  }

  save(config: ConfigFile): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    // Write THEN chmod: `mode` on writeFile is masked by umask and skipped
    // entirely if the file already exists, so an explicit chmod is the only
    // way to guarantee 0600 on every save.
    writeFileSync(this.path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
}

/** An in-memory store for tests that still want to exercise the resolve logic. */
export class MemoryConfigStore implements ConfigStore {
  readonly path = '<memory>';
  private data: ConfigFile;
  constructor(initial: ConfigFile = EMPTY) {
    this.data = structuredClone(initial);
  }
  load(): ConfigFile {
    return structuredClone(this.data);
  }
  save(config: ConfigFile): void {
    this.data = structuredClone(config);
  }
}
