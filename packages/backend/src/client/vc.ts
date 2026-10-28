import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export interface VcClaimMapping {
  name: string;
  /** user_id | email | first_name | last_name | username | public_metadata.<key> */
  source: string;
  /** Selectively disclosable (default true; SD-JWT VC only). */
  disclosable?: boolean;
  /** Typing of the value; full-date is YYYY-MM-DD (an mdoc full-date). */
  value_type?: 'string' | 'number' | 'boolean' | 'full-date';
}

export interface VcCredentialType {
  object: 'vc_credential_type';
  id: string;
  /** The vct, or the docType for mso_mdoc. */
  vct: string;
  format: VcFormat;
  namespace: string | null;
  /** mdoc: PEM IACA roots a presentation must chain to. */
  iaca_roots: string[];
  /** mdoc: issuer revocation checks (certificate CRL / OCSP, MSO status list). */
  revocation_policy: VcRevocationPolicy;
  /** mdoc: PEM Document Signer chain published as x5chain. */
  signer_chain: string[];
  name: string;
  claims: VcClaimMapping[];
  lifetime_seconds: number;
  require_wallet_attestation: boolean;
  created_at: number;
}

export type VcFormat = 'dc+sd-jwt' | 'mso_mdoc';
export type VcRevocationPolicy = 'off' | 'best_effort' | 'required';

export interface CreateVcCredentialTypeBody {
  /** The vct, or the docType for mso_mdoc (for example org.iso.18013.5.1.mDL). */
  vct: string;
  format?: VcFormat;
  /** mso_mdoc: the namespace of the claims (default the docType). */
  namespace?: string;
  /** mso_mdoc: PEM IACA roots (ISO 18013-5 Annex B); with roots set only a certificate chain is accepted. */
  iaca_roots?: string[];
  /** mso_mdoc: off, best_effort (default) or required. */
  revocation_policy?: VcRevocationPolicy;
  /** mso_mdoc: PEM Document Signer certificate (then intermediates) for the instance's mdoc signing key. */
  signer_chain?: string[];
  name: string;
  claims: VcClaimMapping[];
  lifetime_seconds?: number;
  require_wallet_attestation?: boolean;
  wallet_attestation_jwks?: { keys: Record<string, unknown>[] };
}

export interface VcOffer {
  object: 'vc_offer';
  id: string;
  expires_at: number;
  credential_offer: Record<string, unknown>;
  /** The openid-credential-offer:// link for a QR code. Shown once. */
  credential_offer_uri: string;
}

export interface VcCredential {
  object: 'vc_credential';
  id: string;
  credential_type_id: string;
  user_id: string;
  status_idx: number;
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export interface VcPresentationRequest {
  object: 'vc_presentation_request';
  id: string;
  vct: string;
  format: VcFormat;
  iaca_roots: string[];
  revocation_policy: VcRevocationPolicy | null;
  claims: string[];
  status: 'pending' | 'verified' | 'failed';
  result: { issuer: string; vct: string; claims: Record<string, unknown> } | null;
  error: string | null;
  /** Set when the credential was issued by this instance. */
  user_id: string | null;
  expires_at: number;
  request_uri: string;
  /** The openid4vp:// link for a QR code; null for a Digital Credentials API request (use dcApiRequest). */
  authorization_request_uri: string | null;
  client_id_prefix?: VcClientIdPrefix;
  response_mode?: VcResponseMode;
  dcql_query?: Record<string, unknown> | null;
  expected_origins?: string[];
}

export type VcClientIdPrefix = 'redirect_uri' | 'x509_san_dns' | 'x509_hash';
export type VcResponseMode = 'direct_post' | 'direct_post.jwt' | 'dc_api' | 'dc_api.jwt';

/** A credential issuance waiting for an operator decision (OpenID4VCI deferred issuance). */
export interface VcDeferredIssuance {
  object: 'vc_deferred_issuance';
  id: string;
  credential_type_id: string;
  user_id: string;
  credentials_requested: number;
  status: 'pending' | 'approved' | 'denied' | 'issued';
  reason: string | null;
  expires_at: number;
  created_at: number;
}

/** What `navigator.credentials.get({ digital: ... })` takes for a Digital Credentials API request. */
export interface VcDcApiRequest {
  object: 'vc_dc_api_request';
  protocol: 'openid4vp-v1-signed' | 'openid4vp-v1-unsigned';
  data: Record<string, unknown>;
  response_endpoint: string;
}

/** Issue verifiable credentials to wallets (OpenID4VCI) and verify presentations (OpenID4VP), SD-JWT VC. */
export function vcResource(request: RequestFn) {
  return {
    credentialTypes: {
      list(): Promise<ListPage<VcCredentialType>> {
        return request({ method: 'GET', path: '/v1/vc/credential_types' });
      },
      create(body: CreateVcCredentialTypeBody): Promise<VcCredentialType> {
        return request({ method: 'POST', path: '/v1/vc/credential_types', body });
      },
      get(id: string): Promise<VcCredentialType> {
        return request({ method: 'GET', path: `/v1/vc/credential_types/${enc(id)}` });
      },
      delete(id: string): Promise<{ object: 'vc_credential_type'; id: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/vc/credential_types/${enc(id)}` });
      },
    },
    createOffer(body: {
      credential_type_id: string;
      user_id: string;
      /** pre-authorized_code (default) or authorization_code (the wallet signs in first). */
      grant?: 'pre-authorized_code' | 'authorization_code';
      /** Transaction code the user types in the wallet (pre-authorized_code only). */
      tx_code?: string;
      tx_code_description?: string;
      /** Hand the wallet a credential_offer_uri instead of the offer itself. */
      by_reference?: boolean;
      expires_in_seconds?: number;
    }): Promise<VcOffer> {
      return request({ method: 'POST', path: '/v1/vc/offers', body });
    },
    credentials: {
      list(query: { user_id?: string } = {}): Promise<ListPage<VcCredential>> {
        return request({ method: 'GET', path: '/v1/vc/credentials', query: { ...query } });
      },
      revoke(id: string): Promise<VcCredential> {
        return request({ method: 'POST', path: `/v1/vc/credentials/${enc(id)}/revoke` });
      },
    },
    presentationRequests: {
      create(body: {
        vct: string;
        format?: VcFormat;
        /** mso_mdoc: PEM IACA roots for this request. */
        iaca_roots?: string[];
        /** mso_mdoc: overrides the credential type's revocation policy. */
        revocation_policy?: VcRevocationPolicy;
        claims?: string[];
        trusted_issuers?: Array<{ issuer: string; jwks: { keys: Record<string, unknown>[] } }>;
        /** A DCQL query; replaces vct and claims. */
        dcql_query?: Record<string, unknown>;
        client_id_prefix?: VcClientIdPrefix;
        /** PEM certificate chain for the x509 client id prefixes; must match the instance ES256 key. */
        verifier_chain?: string[];
        response_mode?: VcResponseMode;
        /** Web origins allowed to post a Digital Credentials API response. */
        expected_origins?: string[];
        expires_in_seconds?: number;
      }): Promise<VcPresentationRequest> {
        return request({ method: 'POST', path: '/v1/vc/presentation_requests', body });
      },
      get(id: string): Promise<VcPresentationRequest> {
        return request({ method: 'GET', path: `/v1/vc/presentation_requests/${enc(id)}` });
      },
      /** The request for the Digital Credentials API, for a request created with a dc_api response mode. */
      dcApiRequest(id: string): Promise<VcDcApiRequest> {
        return request({ method: 'GET', path: `/v1/vc/presentation_requests/${enc(id)}/dc_api_request` });
      },
    },
    deferred: {
      list(query: { status?: VcDeferredIssuance['status'] } = {}): Promise<ListPage<VcDeferredIssuance>> {
        return request({ method: 'GET', path: '/v1/vc/deferred', query });
      },
      approve(id: string, body: { reason?: string } = {}): Promise<VcDeferredIssuance> {
        return request({ method: 'POST', path: `/v1/vc/deferred/${enc(id)}/approve`, body });
      },
      deny(id: string, body: { reason?: string } = {}): Promise<VcDeferredIssuance> {
        return request({ method: 'POST', path: `/v1/vc/deferred/${enc(id)}/deny`, body });
      },
    },
  };
}
