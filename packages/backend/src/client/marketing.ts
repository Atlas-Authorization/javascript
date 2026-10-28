import { enc, type RequestFn } from './request';
import type { DeletedObject } from './types';

export interface MarketingSettings {
  object: 'marketing_settings';
  capture: { enabled: boolean; params: string[]; default_params: string[]; consent_category: string };
  scripts: { ga4_measurement_id: string | null; gtm_container_id: string | null; hotjar_site_id: number | null; consent_category: string };
}

export interface MarketingSettingsInput {
  capture?: {
    enabled?: boolean;
    /** Lowercase parameter names; empty = the standard set (utm_*, ad click ids). */
    params?: string[];
    consent_category?: string;
  };
  scripts?: {
    /** `G-XXXXXXXX`, or null to remove. */
    ga4_measurement_id?: string | null;
    /** `GTM-XXXXXXX`, or null to remove. */
    gtm_container_id?: string | null;
    hotjar_site_id?: number | null;
    consent_category?: string;
  };
}

export interface MarketingLead {
  id: string;
  email: string;
  name: string | null;
  form: string;
  consent: boolean;
  first_touch: { params?: Record<string, string>; landing_url?: string | null; referrer?: string | null; captured_at?: string } | null;
  created_at: number;
}

export function marketingResource(request: RequestFn) {
  return {
    getSettings(): Promise<MarketingSettings> {
      return request({ method: 'GET', path: '/v1/marketing_settings' });
    },
    updateSettings(body: MarketingSettingsInput): Promise<MarketingSettings> {
      return request({ method: 'PUT', path: '/v1/marketing_settings', body });
    },
    /** The lead / subscribe form's submissions, newest first. */
    listLeads(params: { limit?: number; starting_after?: string; form?: string } = {}): Promise<{ object: 'list'; data: MarketingLead[]; has_more: boolean; next_cursor: string | null }> {
      return request({ method: 'GET', path: '/v1/leads', query: { ...params } });
    },
    /** All leads as CSV text (up to 50,000). */
    exportLeadsCsv(params: { form?: string } = {}): Promise<string> {
      return request({ method: 'GET', path: '/v1/leads', query: { ...params, format: 'csv' }, raw: true });
    },
    deleteLead(id: string): Promise<DeletedObject> {
      return request({ method: 'DELETE', path: `/v1/leads/${enc(id)}` });
    },
  };
}
