import { readFileSync } from 'node:fs';
import { type AtlasClient, createAtlasClient } from '@atlasauth/backend';
import { FileConfigStore, type ConfigStore, defaultConfigPath } from './config';
import { createConfigHttp, type ConfigHttp, type UnknownFieldsNotice } from './config-http';
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
  'users' | 'organizations' | 'apiKeys' | 'webhooks' | 'sessions' | 'actions' | 'actionGallery' | 'actionTemplates' | 'pageTemplates'
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
  makeHttp?: (opts: { secretKey: string; apiUrl: string; headers?: Record<string, string>; onUnknownFields?: (notice: UnknownFieldsNotice) => void }) => ConfigHttp;
  /**
   * Read a file's text, for commands that take a path (`atlas actions deploy`
   * / `test`). Injectable so a test drives them with an in-memory file instead
   * of touching the disk. Defaults to reading UTF-8 off the real filesystem.
   */
  readFile: (path: string) => string;
  /**
   * `fetch` for calls outside the Atlas API (`atlas referrals connect` calls
   * the referral platform's own API). Optional; defaults to the global fetch.
   */
  fetch?: typeof fetch;
  /** Wait between polls (`--wait`). Optional; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Run a program with inherited stdio and return its exit code (`atlas migrate
   * better-auth --run-export` runs the exporter in the app). Optional; defaults
   * to a real child process.
   */
  exec?: (cmd: string, args: string[], opts: { cwd: string }) => Promise<number>;
  /**
   * Run a program and capture its stdout (`atlas doctor --scan-image` reads
   * `docker history`). No shell. Rejects with `code: 'ENOENT'` when the program is
   * missing. Optional; defaults to node's execFile.
   */
  execFile?: (cmd: string, args: string[]) => Promise<string>;
  /** Open a URL in the browser (`atlas login --device`). Optional; defaults to the system opener. */
  openBrowser?: (url: string) => void;
  /** Whether stdin / stdout are terminals. Optional; defaults to the real streams. */
  tty?: { stdin: boolean; stdout: boolean };
  /**
   * Stops a long-running command (`atlas listen`). Optional; defaults to an
   * abort on SIGINT/SIGTERM so Ctrl-C ends the stream cleanly.
   */
  signal?: AbortSignal;
}

/** Whether stdin / stdout are terminals here. */
export function ttyOf(ctx: RunContext): { stdin: boolean; stdout: boolean } {
  return ctx.tty ?? { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true };
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
    makeHttp: (opts) => createConfigHttp(opts),
    readFile: (path) => readFileSync(path, 'utf8'),
    ...overrides,
  };
}
