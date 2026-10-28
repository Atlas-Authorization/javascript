import { enc, type RequestFn } from './request';

export interface AppPreset {
  object: 'app_preset';
  id: string;
  protocol: 'saml' | 'oidc';
  name: string;
  category: string;
  icon_domain: string;
  /** False: the values could not be confirmed in the vendor's docs; check them against the app's SSO settings. */
  verified: boolean;
  /** The vendor SSO documentation the values come from. */
  source_url: string | null;
  /** A private preset of this instance. */
  custom?: boolean;
  params: Array<{ key: string; label: string }>;
}

/** Who may open an installed app; `assigned` admits only the listed users, groups, organizations and roles. */
export interface AppAssignment {
  mode: 'everyone' | 'assigned';
  user_ids?: string[];
  /** Instance group ids or slugs (members of child groups count). */
  groups?: string[];
  organizations?: string[];
  /** Organization role keys. */
  roles?: string[];
}

export interface InstalledApp {
  object: 'installed_app';
  id: string;
  protocol: 'saml' | 'oidc';
  name: string;
  preset_id: string | null;
  entity_id: string | null;
  acs_url: string | null;
  client_id: string | null;
  launch_url: string | null;
  allowed_email_domains: string[];
  assignment: Required<AppAssignment>;
}

export type AppRequestStatus = 'open' | 'building' | 'available' | 'declined';
export interface AppRequest {
  object: 'app_request';
  id: string;
  name: string;
  protocol: 'saml' | 'oidc';
  docs_url: string | null;
  note: string | null;
  status: AppRequestStatus;
  requested_by: string | null;
  votes: number;
  created_at: number;
  updated_at: number;
}

export interface InstallAppBody {
  params?: Record<string, string>;
  installed_id?: string;
  name?: string;
  allowed_email_domains?: string[];
  assignment?: AppAssignment;
}

/** The app catalog: SAML and OpenID Connect presets, installs, and who may open each app. */
export function appCatalogResource(request: RequestFn) {
  return {
    /** `GET /v1/app_catalog` — every preset with its protocol and parameters. */
    presets(query: { q?: string; category?: string; protocol?: 'saml' | 'oidc'; verified?: boolean; limit?: number; offset?: number } = {}): Promise<{ object: 'list'; data: AppPreset[]; total: number; has_more: boolean }> {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) if (v !== undefined) p.set(k, String(v));
      const qs = p.toString();
      return request({ method: 'GET', path: `/v1/app_catalog${qs ? `?${qs}` : ''}` });
    },
    /** `GET /v1/app_catalog/custom_presets` — this instance's private presets in portable form. */
    customPresets(): Promise<{ object: 'list'; data: Array<Record<string, unknown>> }> {
      return request({ method: 'GET', path: '/v1/app_catalog/custom_presets' });
    },
    /** `POST /v1/app_catalog/custom_presets` — save (or replace) a private SAML preset. */
    saveCustomPreset(preset: Record<string, unknown>): Promise<Record<string, unknown>> {
      return request({ method: 'POST', path: '/v1/app_catalog/custom_presets', body: { preset } });
    },
    deleteCustomPreset(id: string): Promise<{ object: 'app_custom_preset'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/app_catalog/custom_presets/${enc(id)}` });
    },
    /** `GET /v1/app_catalog/requests` — apps people asked for, most wanted first. */
    requests(status?: AppRequestStatus): Promise<{ object: 'list'; data: AppRequest[] }> {
      return request({ method: 'GET', path: `/v1/app_catalog/requests${status ? `?status=${status}` : ''}` });
    },
    /** `POST /v1/app_catalog/requests` — ask for an app; asking again for an open one adds a vote. */
    requestApp(body: { name: string; protocol?: 'saml' | 'oidc'; docs_url?: string; note?: string; requested_by?: string }): Promise<AppRequest> {
      return request({ method: 'POST', path: '/v1/app_catalog/requests', body });
    },
    updateRequest(id: string, body: { status?: AppRequestStatus; note?: string }): Promise<AppRequest> {
      return request({ method: 'PATCH', path: `/v1/app_catalog/requests/${enc(id)}`, body });
    },
    deleteRequest(id: string): Promise<{ object: 'app_request'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/app_catalog/requests/${enc(id)}` });
    },
    /** `GET /v1/app_catalog/installed` */
    installed(): Promise<{ object: 'list'; data: InstalledApp[] }> {
      return request({ method: 'GET', path: '/v1/app_catalog/installed' });
    },
    /** `POST /v1/app_catalog/:presetId/install` — an OIDC app's `client_secret` is in this response only. */
    install(presetId: string, body: InstallAppBody = {}, idempotencyKey?: string): Promise<InstalledApp & { client_secret?: string; redirect_uri?: string; issuer?: string }> {
      return request({ method: 'POST', path: `/v1/app_catalog/${enc(presetId)}/install`, body, idempotencyKey });
    },
    /** `PATCH /v1/app_catalog/installed/:id` — name, allowed_email_domains, assignment. */
    update(id: string, body: Pick<InstallAppBody, 'name' | 'allowed_email_domains' | 'assignment'>): Promise<InstalledApp> {
      return request({ method: 'PATCH', path: `/v1/app_catalog/installed/${enc(id)}`, body });
    },
    /** `DELETE /v1/app_catalog/installed/:id` */
    uninstall(id: string): Promise<{ object: 'installed_app'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/app_catalog/installed/${enc(id)}` });
    },
  };
}
