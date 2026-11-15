import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { classifySpecialAddress, isIpLiteral } from './net-address';

/**
 * The fetch the local Web Bot Auth verifier uses for a bot's key directory, a URL the bot chose.
 * The same transport the Atlas server uses: resolve the host once, refuse the request when ANY
 * address is special-purpose (loopback, private, link-local and the cloud metadata address, ULA,
 * multicast, reserved, and IPv6 forms that embed an IPv4 address), connect to the vetted address
 * only (so a second DNS answer cannot redirect it), keep checking the certificate against the
 * original hostname, never follow a redirect, and cap the time and the size. https and port 443
 * only. Node only: edge runtimes cannot resolve DNS and run behind a network sandbox instead.
 */

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_BYTES = 64 * 1024;

export class PinnedFetchError extends Error {
  /** Stable machine code for every refusal. */
  readonly code = 'ssrf_refused';
  constructor(
    readonly reason: string,
  ) {
    super(`Outbound request refused: ${reason}.`);
    this.name = 'PinnedFetchError';
  }
}

const defaultResolve = async (h: string) => (await dnsLookup(h, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Check a URL is safe to connect to and return the one vetted address to pin to. Throws
 * PinnedFetchError (code `ssrf_refused`). Exported so a caller-supplied fetch can be guarded too.
 */
export async function vetPublicUrl(
  input: string | URL,
  opts: { allowHttp?: boolean; resolve?: (hostname: string) => Promise<string[]>; signal?: AbortSignal } = {},
): Promise<{ url: URL; address: string; family: 4 | 6 }> {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new PinnedFetchError('malformed_url');
  }
  const plain = url.protocol === 'http:' && opts.allowHttp === true;
  if (url.protocol !== 'https:' && !plain) throw new PinnedFetchError('not_https');
  if (url.username || url.password) throw new PinnedFetchError('credentials_in_url');
  if (url.port && url.port !== (plain ? '80' : '443')) throw new PinnedFetchError('disallowed_port');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const lower = host.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) throw new PinnedFetchError('loopback');
  const resolve = opts.resolve ?? defaultResolve;
  const signal = opts.signal;
  let addresses: string[];
  if (isIpLiteral(host)) addresses = [host];
  else {
    try {
      addresses = await Promise.race([
        resolve(host),
        ...(signal ? [new Promise<never>((_, rej) => signal.addEventListener('abort', () => rej(new PinnedFetchError('timeout')), { once: true }))] : []),
      ]);
    } catch (e) {
      throw e instanceof PinnedFetchError ? e : new PinnedFetchError('dns_failure');
    }
    if (addresses.length === 0) throw new PinnedFetchError('dns_failure');
  }
  // EVERY address must be public: one public and one private record would be a coin flip an attacker can win.
  for (const address of addresses) {
    const verdict = classifySpecialAddress(address);
    if (verdict) throw new PinnedFetchError(verdict);
    if (!isIpLiteral(address)) throw new PinnedFetchError('dns_failure');
  }
  const address = addresses[0]!;
  return { url, address, family: address.includes(':') ? 6 : 4 };
}

export function createPinnedFetch(
  opts: {
    timeoutMs?: number;
    maxBytes?: number;
    /** Allow plain http (port 80). Off by default. */
    allowHttp?: boolean;
    /** Tests only: resolve a hostname to its addresses instead of asking the OS. */
    resolve?: (hostname: string) => Promise<string[]>;
  } = {},
): typeof fetch {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const signal = AbortSignal.timeout(timeoutMs);
    const { url, address, family } = await vetPublicUrl(typeof input === 'string' || input instanceof URL ? input : input.url, {
      allowHttp: opts.allowHttp,
      resolve: opts.resolve,
      signal,
    });
    const host = url.hostname.replace(/^\[|\]$/g, '');
    // Whatever the socket layer asks for, it gets the vetted address: never a second DNS answer.
    const pinned: LookupFunction = (_h, options, callback) => {
      if ((options as { all?: boolean } | undefined)?.all) {
        (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [{ address, family }]);
      } else {
        callback(null, address, family);
      }
    };
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });

    return new Promise<Response>((resolveResponse, reject) => {
      let settled = false;
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        req.destroy();
        reject(err);
      };
      const req = (url.protocol === 'http:' ? httpRequest : httpsRequest)(
        url,
        { method: (init?.method ?? 'GET').toUpperCase(), headers, lookup: pinned, servername: isIpLiteral(host) ? undefined : url.hostname, agent: false },
        (res: IncomingMessage) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (chunk: Buffer) => {
            if (settled) return;
            size += chunk.length;
            if (size > maxBytes) return fail(new PinnedFetchError('too_large'));
            chunks.push(chunk);
          });
          res.on('error', () => fail(new PinnedFetchError('network_error')));
          res.on('end', () => {
            if (settled) return;
            settled = true;
            req.destroy();
            const out = new Headers();
            for (const [k, v] of Object.entries(res.headers)) {
              if (Array.isArray(v)) v.forEach((x) => out.append(k, x));
              else if (v !== undefined) out.set(k, v);
            }
            const status = res.statusCode ?? 502;
            resolveResponse(new Response([101, 204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status: status < 200 || status > 599 ? 502 : status, headers: out }));
          });
        },
      );
      req.on('error', () => fail(new PinnedFetchError('network_error')));
      signal.addEventListener('abort', () => fail(new PinnedFetchError('timeout')), { once: true });
      req.end();
    });
  }) as typeof fetch;
}
