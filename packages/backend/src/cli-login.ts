import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
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
  /**
   * The API the access token is for (RFC 8707): sent on the authorize request, device authorization, code
   * exchange and every refresh, so the token's `aud` is this resource. A list is accepted for convenience,
   * but Atlas binds a sign-in to ONE API: more than one distinct value throws.
   */
  resource?: string | string[];
  /**
   * `loopback`: open the browser at the authorization endpoint and catch the redirect on `http://127.0.0.1:<random port>/callback`
   * (authorization code + PKCE; register `http://127.0.0.1/callback` as the client's redirect URI). `device`: show a code to
   * confirm (works over SSH and without a browser). `auto` (default): loopback when a browser can open on this machine, else device.
   */
  mode?: 'auto' | 'loopback' | 'device';
  /** Extra query parameters on the authorize request (loopback), e.g. `{ prompt: 'login', login_hint: 'a@example.com' }`. Protocol parameters cannot be overridden. */
  extraAuthorizeParams?: Record<string, string>;
  /** How long loopback sign-in waits for the browser to come back, in milliseconds (default 300000). */
  loopbackTimeoutMs?: number;
  /** Path of the loopback redirect (default `/callback`); must match the registered redirect URI's path. */
  loopbackPath?: string;
  /** Replaces the default browser opener (tests, or a custom launcher). */
  open?: (url: string) => void;
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

const RESERVED_AUTHORIZE_PARAMS = new Set([
  'response_type', 'client_id', 'redirect_uri', 'scope', 'state', 'code_challenge', 'code_challenge_method', 'resource',
]);

const b64url = (b: Buffer) => b.toString('base64url');

function singleResource(resource: string | string[] | undefined): string | undefined {
  if (resource === undefined) return undefined;
  const distinct = [...new Set((Array.isArray(resource) ? resource : [resource]).filter(Boolean))];
  if (distinct.length > 1) throw new Error('createCliLogin: Atlas binds a sign-in to one resource; pass a single `resource`.');
  return distinct[0];
}

const PAGE = (title: string, body: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1><p>${body}</p>`;

/**
 * Loopback sign-in (RFC 8252 §7.3): a one-shot HTTP server on 127.0.0.1 and a random port waits for ONE valid redirect
 * carrying the right `state`; anything else gets a 4xx and the wait continues until the timeout. Resolves the code.
 */
function waitForLoopbackCode(args: { path: string; state: string; timeoutMs: number; onListening: (redirectUri: string) => void }): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    let redirectUri = '';
    const expected = Buffer.from(args.state);
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const reply = (status: number, title: string, body: string) => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
        res.end(PAGE(title, body));
      };
      if (req.method !== 'GET' || url.pathname !== args.path) return reply(404, 'Not found', 'This is not the sign-in callback.');
      const got = Buffer.from(url.searchParams.get('state') ?? '');
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) return reply(400, 'Sign-in failed', 'The state did not match. Run the login again.');
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      done(() => (error ? reject(new Error(`Sign-in was refused: ${error}${url.searchParams.get('error_description') ? ` (${url.searchParams.get('error_description')})` : ''}.`)) : code ? resolve({ code, redirectUri }) : reject(new Error('The sign-in redirect carried no code.'))));
      if (error || !code) return reply(400, 'Sign-in failed', 'You can close this tab and try again.');
      reply(200, 'Signed in', 'You can close this tab and return to your terminal.');
    });
    const timer = setTimeout(() => done(() => reject(new Error('Timed out waiting for the browser sign-in.'))), args.timeoutMs);
    let finished = false;
    function done(settle: () => void) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      settle();
      // Let the page reach the browser, then stop listening: one sign-in per server.
      setTimeout(() => { server.close(); server.closeAllConnections?.(); }, 250).unref();
    }
    server.on('error', (e) => done(() => reject(e)));
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return done(() => reject(new Error('Could not open a loopback port.')));
      redirectUri = `http://127.0.0.1:${addr.port}${args.path}`;
      args.onListening(redirectUri);
    });
  });
}

export function createCliLogin(opts: CliLoginOptions) {
  const resource = singleResource(opts.resource);
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
    const res = await post('token', { grant_type: 'refresh_token', refresh_token: old.refresh_token!, client_id: opts.clientId, ...(resource ? { resource } : {}) }).catch(() => null);
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

  const open = opts.open ?? openInBrowser;
  const canOpenBrowser = () => opts.openBrowser !== false && (opts.open !== undefined || (!!process.stdout.isTTY && !process.env.CI && !process.env.SSH_CONNECTION));

  async function loginDevice(): Promise<CliSession> {
    const start = await startDeviceAuthorization({ issuer, clientId: opts.clientId, scope, resource }, { fetch: f });
    print(`Open ${start.verification_uri_complete}`);
    print(`and confirm the code ${start.user_code}.`);
    if (canOpenBrowser()) open(start.verification_uri_complete);
    const tokens = await pollDeviceAuthorization(start, { fetch: f, sleep: opts.sleep });
    const session = toSession(tokens);
    await store.save(session);
    return session;
  }

  async function loginLoopback(): Promise<CliSession> {
    const verifier = b64url(randomBytes(32));
    const state = b64url(randomBytes(16));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const path = opts.loopbackPath ?? '/callback';
    const { code, redirectUri } = await waitForLoopbackCode({
      path,
      state,
      timeoutMs: opts.loopbackTimeoutMs ?? 300_000,
      onListening: (redirectUri) => {
        const url = new URL(`${issuer}/oauth2/authorize`);
        for (const [k, v] of Object.entries(opts.extraAuthorizeParams ?? {})) if (!RESERVED_AUTHORIZE_PARAMS.has(k)) url.searchParams.set(k, v);
        url.searchParams.set('response_type', 'code');
        url.searchParams.set('client_id', opts.clientId);
        url.searchParams.set('redirect_uri', redirectUri);
        url.searchParams.set('scope', scope);
        url.searchParams.set('state', state);
        url.searchParams.set('code_challenge', challenge);
        url.searchParams.set('code_challenge_method', 'S256');
        if (resource) url.searchParams.set('resource', resource);
        print(`Open ${url.toString()}`);
        print('and sign in; this window continues when you are done.');
        if (canOpenBrowser()) open(url.toString());
      },
    });
    const res = await post('token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: opts.clientId,
      code_verifier: verifier,
      ...(resource ? { resource } : {}),
    });
    const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof out.access_token !== 'string') {
      throw new Error(`Sign-in failed: ${String(out.error_description ?? out.error ?? res.status)}.`);
    }
    const session = toSession(out as unknown as OAuthTokenResponse);
    await store.save(session);
    return session;
  }

  return {
    async login(): Promise<CliSession> {
      const mode = opts.mode ?? 'auto';
      if (mode === 'device') return loginDevice();
      if (mode === 'loopback') return loginLoopback();
      // auto: loopback when a browser can open on this machine, else the device flow. A loopback port that
      // cannot be opened (a locked-down host) falls back to the device flow too.
      if (!canOpenBrowser()) return loginDevice();
      try {
        return await loginLoopback();
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code && String((e as NodeJS.ErrnoException).code).startsWith('E')) return loginDevice();
        throw e;
      }
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
