import { enc, type RequestFn } from './request';



export interface SsoConnectionsListSigningKeysQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type SsoConnectionsListSigningKeysResult = {
  object: 'list';
  data: ({
    object: 'upstream_signing_key';
    kid: string;
    alg: 'RS256' | 'PS256' | 'ES256';
    /** active signs assertions; retiring is still published; retired is gone. */
    status: 'active' | 'retiring' | 'retired';
    /** The public JWK (never the private key). */
    public_jwk: Record<string, unknown>;
    /** Created (epoch ms). */
    created_at: number;
    retired_at?: number | null;
  })[];
};

export type SsoConnectionsCreateSigningKeyBody = {
  alg?: 'RS256' | 'PS256' | 'ES256';
};

export type SsoConnectionsCreateSigningKeyResult = {
  object: 'upstream_signing_key';
  kid: string;
  alg: 'RS256' | 'PS256' | 'ES256';
  /** active signs assertions; retiring is still published; retired is gone. */
  status: 'active' | 'retiring' | 'retired';
  /** The public JWK (never the private key). */
  public_jwk: Record<string, unknown>;
  /** Created (epoch ms). */
  created_at: number;
  retired_at?: number | null;
};

export type SsoConnectionsRetireSigningKeyResult = {
  object?: 'upstream_signing_key';
  kid?: string;
  status?: 'retired';
};

/** Operations on `/v1/sso_connections` (3). */
export function ssoConnectionsOpsResource(request: RequestFn) {
  return {
    /** An OIDC connection's private_key_jwt signing keys (public halves only). */
    listSigningKeys(id: string, query?: SsoConnectionsListSigningKeysQuery): Promise<SsoConnectionsListSigningKeysResult> {
      return request({ method: 'GET', path: `/v1/sso_connections/${enc(id)}/signing_keys`, query: { ...query } });
    },
    /** Generate (rotate) the private_key_jwt signing key of an OIDC connection; the previous one turns retiring. */
    createSigningKey(id: string, body: SsoConnectionsCreateSigningKeyBody, idempotencyKey?: string): Promise<SsoConnectionsCreateSigningKeyResult> {
      return request({ method: 'POST', path: `/v1/sso_connections/${enc(id)}/signing_keys`, body, idempotencyKey });
    },
    /** Retire an OIDC connection signing key (not the active one). */
    retireSigningKey(id: string, kid: string): Promise<SsoConnectionsRetireSigningKeyResult> {
      return request({ method: 'POST', path: `/v1/sso_connections/${enc(id)}/signing_keys/${enc(kid)}/retire` });
    },
  };
}
