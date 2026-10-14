import { readFileSync } from 'node:fs';
import { type AtlasClient, createAtlasClient } from '@atlasauth/backend';
import { FileConfigStore, type ConfigStore, defaultConfigPath } from './config';
import { createConfigHttp, type ConfigHttp } from './config-http';
import { defaultIO, type IO } from './io';
import { defaultPrompter, type Prompter } from './prompt';

/**
 * The exact slice of the Backend API client this CLI drives. Narrowed from the
 * full {@link AtlasClient} on purpose: it documents — and the typechecker
 * enforces — that the command set maps only onto namespaces that really exist,
 * and it keeps the fake a test injects small (five namespaces, not forty).
 */
export type ManagementClient = Pick<
  AtlasClient,
  'users' | 'organizations' | 'apiKeys' | 'webhooks' | 'sessions' | 'actions'
>;

/**
 * Everything a command touches the outside world through, in one injectable
 * bag. Production wires the real IO/config/prompt/client; every test builds
 * this with fakes so a handler runs with no network, no TTY and no real
 * `~/.config` file.
 */
export interface RunContext {
  io: IO;
  /** Process environment — read for `ATLAS_SECRET_KEY` / `ATLAS_API_URL`. */
  env: NodeJS.ProcessEnv;
  config: ConfigStore;
  prompt: Prompter;
  /** Builds the Backend API client from a resolved credential. */
  makeClient: (opts: { secretKey: string; apiUrl: string }) => ManagementClient;
  /**
   * Builds the raw management-API HTTP client used by `atlas config` (the
   * config-only `/v1` endpoints the typed client omits). Optional so existing
   * contexts stay valid; the config command falls back to the real one.
   */
  makeHttp?: (opts: { secretKey: string; apiUrl: string }) => ConfigHttp;
  /**
   * Read a file's text, for commands that take a path (`atlas actions deploy`
   * / `test`). Injectable so a test drives them with an in-memory file instead
   * of touching the disk. Defaults to reading UTF-8 off the real filesystem.
   */
  readFile: (path: string) => string;
}

/**
 * The production context, with any piece overridable. Tests call this with a
 * `config` pointed at a temp path and a `makeClient` returning a stub, so the
 * same `run()` path is exercised end to end without side effects.
 */
export function defaultContext(overrides: Partial<RunContext> = {}): RunContext {
  return {
    io: defaultIO(),
    env: process.env,
    config: new FileConfigStore(defaultConfigPath()),
    prompt: defaultPrompter(),
    makeClient: ({ secretKey, apiUrl }) => createAtlasClient({ secretKey, apiUrl }),
    makeHttp: ({ secretKey, apiUrl }) => createConfigHttp({ secretKey, apiUrl }),
    readFile: (path) => readFileSync(path, 'utf8'),
    ...overrides,
  };
}
