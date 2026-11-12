import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pollDeviceAuthorization, startDeviceAuthorization, type OAuthTokenResponse } from './client/operator';

/** Browser sign-in for a command-line tool of your own: the device flow against your instance, with a stored, refreshing session. */

export interface CliSession {
  access_token: string;
  refresh_token?: string;
  /** Epoch milliseconds. */
  expires_at: number;
  scope?: string;
  issuer: string;
  client_id: string;
}

/** Where the session lives; pass your own to use an OS keychain. */
export interface CliSessionStore {
  load(): Promise<CliSession | null> | CliSession | null;
  save(session: CliSession): Promise<void> | void;
  clear(): Promise<void> | void;
}

export class CliLoginRequiredError extends Error {
  constructor(appName: string) {
    super(`Not signed in. Run \`${appName} login\`.`);
    this.name = 'CliLoginRequiredError';
  }
}

export interface CliLoginOptions {
  issuer: string;
  clientId: string;
  appName: string;
  scope?: string | string[];
  store?: CliSessionStore;
  /** Open the sign-in page in the browser (default true; never in CI or without a terminal). */
  openBrowser?: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  print?: (line: string) => void;
}

/** Open a URL in the default browser. Every failure is ignored: the URL is printed anyway. */
export function openInBrowser(url: string): void {
  // Only web URLs, and never through a shell: `cmd /c start` would run whatever follows an `&`.
  if (!/^https?:\/\/[^\s"]+$/i.test(url)) return;
  try {
    const [cmd, args] =
      process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // ignored on purpose
  }
}

function sessionPath(appName: string): string {
  // The name becomes a directory, so it must be one plain segment.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(appName) || appName.includes('..')) throw new Error(`Invalid appName "${appName}": use letters, digits, ".", "_" or "-".`);
  const env = process.env;
  const base = process.platform === 'win32' ? env.APPDATA || join(homedir(), 'AppData', 'Roaming') : env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(base, appName, 'atlas-session.json');
}

function fileStore(appName: string): CliSessionStore {
  const file = sessionPath(appName);
  return {
    async load() {
      try {
        return JSON.parse(await readFile(file, 'utf8')) as CliSession;
      } catch {
        return null;
      }
    },
    async save(session) {
      const dir = join(file, '..');
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700).catch(() => {});
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(session), { mode: 0o600 });
      await rename(tmp, file);
    },
    async clear() {
      await rm(file, { force: true });
    },
  };
}

export function createCliLogin(opts: CliLoginOptions) {
  const issuer = opts.issuer.replace(/\/+$/, '');
  const f = opts.fetch ?? globalThis.fetch;
  const now = opts.now ?? Date.now;
  const print = opts.print ?? ((line: string) => console.log(line));
  const store = opts.store ?? fileStore(opts.appName);
  const scope = Array.isArray(opts.scope) ? opts.scope.join(' ') : opts.scope ?? 'openid profile email offline_access';
  let refreshing: Promise<CliSession> | null = null;

  // A session for another issuer or client is not ours to use.
  const load = async (): Promise<CliSession | null> => {
    const s = await store.load();
    return s && s.issuer === issuer && s.client_id === opts.clientId ? s : null;
  };
  const toSession = (t: OAuthTokenResponse, prev?: CliSession): CliSession => ({
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? prev?.refresh_token,
    expires_at: now() + t.expires_in * 1000,
    scope: t.scope ?? prev?.scope ?? scope,
    issuer,
    client_id: opts.clientId,
  });
  const post = (path: string, body: Record<string, string>) =>
    f(`${issuer}/oauth2/${path}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });

  async function refresh(old: CliSession): Promise<CliSession> {
    const res = await post('token', { grant_type: 'refresh_token', refresh_token: old.refresh_token!, client_id: opts.clientId }).catch(() => null);
    const out = res ? ((await res.json().catch(() => ({}))) as Record<string, unknown>) : {};
    if (res?.ok && typeof out.access_token === 'string') {
      const next = toSession(out as unknown as OAuthTokenResponse, old);
      await store.save(next);
      return next;
    }
    // Only a refusal ends the session; a network blip or 5xx keeps it for the next try.
    if (res && res.status >= 400 && res.status < 500) await store.clear();
    throw new CliLoginRequiredError(opts.appName);
  }

  return {
    async login(): Promise<CliSession> {
      const start = await startDeviceAuthorization({ issuer, clientId: opts.clientId, scope }, { fetch: f });
      print(`Open ${start.verification_uri_complete}`);
      print(`and confirm the code ${start.user_code}.`);
      if (opts.openBrowser !== false && process.stdout.isTTY && !process.env.CI) openInBrowser(start.verification_uri_complete);
      const tokens = await pollDeviceAuthorization(start, { fetch: f, sleep: opts.sleep });
      const session = toSession(tokens);
      await store.save(session);
      return session;
    },

    /** A valid access token, refreshed first when it expires within 60 seconds. */
    async getAccessToken(): Promise<string> {
      const s = await load();
      if (!s) throw new CliLoginRequiredError(opts.appName);
      if (s.expires_at - now() > 60_000) return s.access_token;
      if (!s.refresh_token) throw new CliLoginRequiredError(opts.appName);
      refreshing ??= refresh(s).finally(() => (refreshing = null));
      return (await refreshing).access_token;
    },

    /** Revoke at the issuer (best effort), then forget the session. Never throws on network failure. */
    async logout(): Promise<void> {
      const s = await load();
      if (s) {
        const tokens: Array<[string, string]> = [];
        if (s.refresh_token) tokens.push([s.refresh_token, 'refresh_token']);
        tokens.push([s.access_token, 'access_token']);
        for (const [token, hint] of tokens) await post('revoke', { token, token_type_hint: hint, client_id: opts.clientId }).catch(() => {});
      }
      await store.clear();
    },

    /** What is stored, without any network call. */
    async status(): Promise<{ signedIn: boolean; expiresAt: number | null; scope: string | null }> {
      const s = await load();
      return { signedIn: !!s, expiresAt: s?.expires_at ?? null, scope: s?.scope ?? null };
    },
  };
}
