import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/**
 * This instance as a PARTNER PLATFORM of another product: a product that signs
 * its partner deliveries with a published Ed25519 key set (Cookie Munch is a
 * preset). The partner delivers signed consent events to the instance's
 * receiver; registering is done by the partner from the registration details,
 * and the partner token it hands back is stored once, encrypted, never shown.
 */

export interface PartnerPlatform {
  object: 'partner_platform';
  id: string;
  partner: string;
  name: string;
  preset: boolean;
  platform_id: string;
  enabled: boolean;
  jwks_url: string;
  signature_header: string;
  signature_scheme: 't_kid_ed25519';
  tolerance_seconds: number;
  allowed_sources: string[];
  record_consents: boolean;
  receiver_url: string;
  receiver_url_template: string;
  serves_deployment: boolean;
  registration: { status: 'unregistered' | 'registered'; registered_at: number | null };
  token_set: boolean;
  token_prefix: string | null;
  last_delivery_at: number | null;
  last_delivery_error: string | null;
  created_at: number;
  updated_at: number;
}

export interface PartnerPlatformInput {
  name?: string | null;
  platform_id?: string;
  enabled?: boolean;
  jwks_url?: string;
  signature_header?: string;
  signature_scheme?: 't_kid_ed25519';
  tolerance_seconds?: number;
  allowed_sources?: string[];
  record_consents?: boolean;
  serves_deployment?: boolean;
}

export interface PartnerPlatformRegistration {
  object: 'partner_platform_registration';
  partner: string;
  platform_id: string;
  receiver_url: string;
  receiver_url_is_template: boolean;
  external_id: string | null;
  events: string[];
  signature: { header: string; scheme: string; format: string; jwks_url: string; tolerance_seconds: number };
  send_to: { contact: string; docs: string } | null;
  token_prefix: string | null;
  next_step: string;
}

export interface PartnerDelivery {
  object: 'partner_delivery';
  event_id: string | null;
  event_type: string | null;
  outcome: 'recorded' | 'unchanged' | 'no_subject' | 'no_user' | 'source_not_allowed' | 'ignored';
  user_id: string | null;
  received_at: number;
}

export function partnerPlatformsResource(request: RequestFn) {
  const path = (partner: string, rest = '') => `/v1/partner_platforms/${enc(partner)}${rest}`;
  return {
    list(): Promise<ListPage<PartnerPlatform> & { presets: Array<Record<string, unknown>> }> {
      return request({ method: 'GET', path: '/v1/partner_platforms' });
    },
    get(partner: string): Promise<PartnerPlatform> {
      return request({ method: 'GET', path: path(partner) });
    },
    /** Set up or change (a preset such as `cookiemunch` fills the defaults). */
    set(partner: string, body: PartnerPlatformInput = {}): Promise<PartnerPlatform> {
      return request({ method: 'PUT', path: path(partner), body });
    },
    remove(partner: string): Promise<{ object: 'partner_platform'; partner: string; deleted: true }> {
      return request({ method: 'DELETE', path: path(partner) });
    },
    /** What to send the partner to be registered (receiver URL, signature expectations, where to send it). */
    registration(partner: string): Promise<PartnerPlatformRegistration> {
      return request({ method: 'GET', path: path(partner, '/registration') });
    },
    /** Store the partner token the partner handed over (once; `rotate` replaces it). */
    storeToken(partner: string, body: { token: string; rotate?: boolean; api_base_url?: string }): Promise<PartnerPlatform> {
      return request({ method: 'POST', path: path(partner, '/token'), body });
    },
    deliveries(partner: string, params: { limit?: number } = {}): Promise<ListPage<PartnerDelivery>> {
      return request({
        method: 'GET',
        path: path(partner, '/deliveries'),
        ...(params.limit ? { query: { limit: String(params.limit) } } : {}),
      });
    },
  };
}
