import { enc, type RequestFn } from './request';

/** A trusted-JWT connection: your system signs a short-lived JWT and sends the person to `login_url`. */
export interface JwtConnection {
  object: 'jwt_connection';
  id: string;
  organization_id: string | null;
  status: 'draft' | 'active' | 'disabled';
  jwks_uri: string | null;
  issuer: string | null;
  audience: string | null;
  email_claim: string;
  max_age_seconds: number;
  default_role_id: string | null;
  /** Send the person here with ?token=<jwt>&redirect_url=<your app URL>. */
  login_url: string;
  created_at: number;
  updated_at: number;
}

export interface JwtConnectionBody {
  organization_id?: string | null;
  status?: 'draft' | 'active' | 'disabled';
  /** An https URL serving your public signing keys (RS / PS / ES / EdDSA). */
  jwks_uri?: string;
  issuer?: string;
  audience?: string;
  /** Default email. */
  email_claim?: string;
  /** exp − iat at most this; 30–3600, default 300. */
  max_age_seconds?: number;
  default_role_id?: string | null;
}

export function jwtConnectionsResource(request: RequestFn) {
  return {
    list(): Promise<{ object: 'list'; data: JwtConnection[]; has_more: boolean }> {
      return request({ method: 'GET', path: '/v1/jwt_connections' });
    },
    get(id: string): Promise<JwtConnection> {
      return request({ method: 'GET', path: `/v1/jwt_connections/${enc(id)}` });
    },
    create(body: JwtConnectionBody, idempotencyKey?: string): Promise<JwtConnection> {
      return request({ method: 'POST', path: '/v1/jwt_connections', body, idempotencyKey });
    },
    update(id: string, body: JwtConnectionBody): Promise<JwtConnection> {
      return request({ method: 'PATCH', path: `/v1/jwt_connections/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'jwt_connection'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/jwt_connections/${enc(id)}` });
    },
  };
}
