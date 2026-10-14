import type { RequestFn } from './request';

export interface CreateTicketBody {
  /** Lifetime in seconds; must be positive, clamped to 86400 (24h). */
  ttl_seconds: number;
  /** Arbitrary JSON returned to whoever redeems the ticket. Defaults to `{}`. */
  payload?: unknown;
  /** Default true: the first successful redeem consumes it. */
  single_use?: boolean;
  /** Only a redeemer acting as this user may redeem. */
  bound_user?: string;
  /** Only a redeemer acting for this organization may redeem. */
  bound_org?: string;
}

/** A minted capability ticket. `ticket` (the `tkt_…` secret) is returned only here. */
export interface CapabilityTicket {
  object: 'ticket';
  id: string;
  ticket: string;
  single_use: boolean;
  bound_user: string | null;
  bound_org: string | null;
  created_at: number;
  expires_at: number;
}

export interface RedeemTicketBody {
  /** The `tkt_…` secret. */
  ticket: string;
  /** Who this redemption is on behalf of (matched against `bound_user`). */
  for_user?: string;
  /** The organization it is for (matched against `bound_org`). */
  for_org?: string;
}

export interface TicketRedemption<P = unknown> {
  object: 'ticket_redemption';
  /** The redeemed ticket id. */
  id: string;
  /** The payload the ticket carried, verbatim. */
  payload: P;
  single_use: boolean;
}

export function ticketsResource(request: RequestFn) {
  return {
    /** Mint a one-time capability ticket. */
    create(body: CreateTicketBody, idempotencyKey?: string): Promise<CapabilityTicket> {
      return request({ method: 'POST', path: '/v1/tickets', body, idempotencyKey });
    },
    /**
     * Redeem a ticket server-to-server. Unknown, expired or used tickets are a
     * 404; a binding mismatch is a 403.
     */
    redeem<P = unknown>(body: RedeemTicketBody): Promise<TicketRedemption<P>> {
      return request({ method: 'POST', path: '/v1/tickets/redeem', body });
    },
  };
}
