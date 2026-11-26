import type { CapabilityTicket, CreateTicketBody, RedeemTicketBody, TicketRedemption } from './client/tickets';

/**
 * Sign in on one host, finish on another: a hub host (where people sign in with Atlas) hands the signed-in user to a
 * tenant's own domain with a single-use code. The hub's backend calls {@link createDomainHandoff} and redirects the browser to
 * the returned `url`; the tenant domain's backend calls {@link redeemDomainHandoff} with the `code` it received, learns who
 * signed in, and starts its own session on that domain.
 *
 * The code is an Atlas capability ticket: single use (the first redeem consumes it, a replay is refused), short-lived
 * (5 minutes at most), instance-scoped, audited on both ends, and it names the domain it was minted for, so a code minted
 * for one tenant domain cannot sign anyone in on another.
 */

/** The slice of `AtlasBackend` the handoff needs (`new AtlasBackend({ secretKey, ... })` satisfies it). */
export interface DomainHandoffClient {
  tickets: {
    create(body: CreateTicketBody): Promise<CapabilityTicket>;
    redeem<P = unknown>(body: RedeemTicketBody): Promise<TicketRedemption<P>>;
  };
}

export const DOMAIN_HANDOFF_DEFAULT_TTL_SECONDS = 60;
export const DOMAIN_HANDOFF_MAX_TTL_SECONDS = 300;
const KIND = 'domain_handoff';

export type DomainHandoffErrorCode = 'invalid_target' | 'invalid_code' | 'audience_mismatch' | 'not_a_handoff';

export class DomainHandoffError extends Error {
  constructor(
    readonly code: DomainHandoffErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainHandoffError';
  }
}

export interface CreateDomainHandoffInput {
  /** The Atlas user who signed in on the hub. */
  userId: string;
  /** Where the browser goes next: the tenant domain's callback URL (https; http only for localhost). */
  targetUrl: string;
  /** Lifetime in seconds. Default 60, at most 300. */
  ttlSeconds?: number;
  /** Where the tenant domain should send the person afterwards (a path or URL on the tenant domain). */
  returnTo?: string;
  /** The organization (pool, tenant) the sign-in was for. */
  organizationId?: string;
  /** Name of the query parameter that carries the code. Default `code`. */
  codeParam?: string;
}

export interface DomainHandoff {
  /** The single-use code. */
  code: string;
  /** `targetUrl` with the code appended: redirect the browser here. */
  url: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

function originOf(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DomainHandoffError('invalid_target', 'The target must be an absolute URL.');
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new DomainHandoffError('invalid_target', 'The target must be an https URL (http only for localhost).');
  }
  if (url.username || url.password) throw new DomainHandoffError('invalid_target', 'The target must not carry credentials.');
  return url.origin;
}

/** Hub side: mint the code for one tenant domain and build the redirect URL. */
export async function createDomainHandoff(atlas: DomainHandoffClient, input: CreateDomainHandoffInput): Promise<DomainHandoff> {
  const audience = originOf(input.targetUrl);
  const ttl = Math.min(Math.max(Math.floor(input.ttlSeconds ?? DOMAIN_HANDOFF_DEFAULT_TTL_SECONDS), 1), DOMAIN_HANDOFF_MAX_TTL_SECONDS);
  const ticket = await atlas.tickets.create({
    ttl_seconds: ttl,
    single_use: true,
    payload: {
      kind: KIND,
      user_id: input.userId,
      audience,
      ...(input.returnTo ? { return_to: input.returnTo } : {}),
      ...(input.organizationId ? { organization_id: input.organizationId } : {}),
    },
  });
  const url = new URL(input.targetUrl);
  url.searchParams.set(input.codeParam ?? 'code', ticket.ticket);
  return { code: ticket.ticket, url: url.toString(), expiresAt: ticket.expires_at };
}

export interface RedeemDomainHandoffOptions {
  /** The origin this server answers on (for example `https://shop.example.com`). A code minted for any other origin is refused. */
  expectedOrigin: string;
}

export interface RedeemedDomainHandoff {
  userId: string;
  returnTo: string | null;
  organizationId: string | null;
}

/**
 * Tenant-domain side: redeem the code. A code is consumed by the first redeem, even one that is then refused for naming
 * another domain, so a leaked code is dead either way. An unknown, expired or already-used code is `invalid_code`.
 */
export async function redeemDomainHandoff(
  atlas: DomainHandoffClient,
  code: string,
  options: RedeemDomainHandoffOptions,
): Promise<RedeemedDomainHandoff> {
  if (typeof code !== 'string' || !code) throw new DomainHandoffError('invalid_code', 'A handoff code is required.');
  const expected = originOf(options.expectedOrigin);
  let redemption: TicketRedemption<Record<string, unknown> | null>;
  try {
    redemption = await atlas.tickets.redeem<Record<string, unknown> | null>({ ticket: code });
  } catch {
    throw new DomainHandoffError('invalid_code', 'That handoff code is invalid, expired or already used.');
  }
  const p = redemption.payload;
  if (!p || typeof p !== 'object' || p.kind !== KIND || typeof p.user_id !== 'string' || typeof p.audience !== 'string') {
    throw new DomainHandoffError('not_a_handoff', 'That code is not a domain handoff code.');
  }
  if (p.audience !== expected) {
    throw new DomainHandoffError('audience_mismatch', 'That code was issued for a different domain.');
  }
  return {
    userId: p.user_id,
    returnTo: typeof p.return_to === 'string' ? p.return_to : null,
    organizationId: typeof p.organization_id === 'string' ? p.organization_id : null,
  };
}
