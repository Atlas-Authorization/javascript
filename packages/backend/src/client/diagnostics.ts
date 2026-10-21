import type { RequestFn } from './request';

export interface LoginReadinessParams {
  /** The app origin to probe, e.g. `https://app.acme.com`. */
  origin: string;
  /** Round-trip the published JWKS for the signing check instead of inferring it. */
  live?: boolean;
}

export interface LoginReadinessCheck {
  name: string;
  pass: boolean;
  /**
   * `false` when the check does not matter for the assumed integration (it
   * then never makes `ready` false). Absent from older servers.
   */
  applies?: boolean;
  observed: unknown;
  /** What was seen, and the fix when it fails. */
  detail: string;
}

export interface LoginReadiness {
  object: 'login_readiness';
  origin: string;
  live: boolean;
  data_region?: string | null;
  /** Every check that applies to the assumed integration passes. */
  ready: boolean;
  /** The integration the checks assumed for this origin, and why. */
  integration?: LoginReadinessIntegration;
  checks: LoginReadinessCheck[];
}

export interface LoginReadinessIntegration {
  /** `redirect`: hosted-redirect OIDC, so the `cors` and `session_cookie` checks do not apply. */
  assumed: 'redirect' | 'embedded';
  /** `declared` | `embedded_traffic` | `redirect_clients` | `default`. */
  source: 'declared' | 'embedded_traffic' | 'redirect_clients' | 'default';
  /** A plain sentence saying why. */
  reason: string;
}

export interface RequestInspectorParams {
  /** The browser origin making the request. */
  origin: string;
  /** Default `POST`. */
  method?: string;
  /** Default `/v1/client/sign_ins`. */
  path?: string;
  /** A session JWT to verify against this instance. */
  token?: string;
}

export interface RequestInspectionFinding {
  check: string;
  /** Whether this finding alone rejects the request. */
  blocks: boolean;
  observed: unknown;
  detail: string;
}

export interface RequestInspection {
  object: 'request_inspection';
  origin: string;
  method: string;
  path: string;
  would_be_rejected: boolean;
  findings: RequestInspectionFinding[];
}

export function diagnosticsResource(request: RequestFn) {
  return {
    /** Will a browser sign-in from `origin` work? CORS, cookie, email claim and signing, each with a fix. */
    loginReadiness(params: LoginReadinessParams): Promise<LoginReadiness> {
      return request({
        method: 'GET',
        path: '/v1/diagnostics/login_readiness',
        query: { origin: params.origin, live: params.live },
      });
    },
    /** Why would this browser request be rejected? Each finding says whether it blocks. */
    requestInspector(params: RequestInspectorParams): Promise<RequestInspection> {
      return request({
        method: 'GET',
        path: '/v1/diagnostics/request_inspector',
        query: { ...params },
      });
    },
  };
}
