import { enc, type RequestFn } from './request';

/**
 * Signed policy bundles: the instance's ABAC policies and FGA authorization
 * models as one versioned tar.gz with a manifest of file digests, signed with the
 * instance signing key (detached JWS). Export, verify, and import with a dry-run
 * diff. To check a bundle WITHOUT calling Atlas, use `verifyPolicyBundle`.
 */

export interface PolicyBundle {
  object: 'policy_bundle';
  /** A digest of the bundle CONTENT (`rev_…`): the same policy has the same revision everywhere. */
  revision: string;
  sha256: string;
  size: number;
  key_id: string;
  algorithm: 'RS256' | 'ES256';
  /** Detached compact JWS (`header..signature`) over the archive bytes. */
  signature: string;
  origin: 'export' | 'import';
  manifest: Record<string, unknown>;
  /** The tar.gz, base64. Present on export and get; omitted from lists. */
  bundle?: string;
  media_type?: 'application/gzip';
  created_at: number;
}

export interface PolicyBundleUpload {
  /** The tar.gz, base64 (a `Uint8Array` is encoded for you). */
  bundle: string | Uint8Array;
  signature: string;
  /** Public keys to trust in addition to this instance's, e.g. the staging instance when promoting to production. */
  trusted_jwks?: { keys: Array<Record<string, unknown>> };
}

export interface PolicyBundleVerification {
  object: 'policy_bundle_verification';
  /** Signature AND integrity both check out. */
  valid: boolean;
  signature: { valid: boolean; key_id: string | null; algorithm: string | null; error?: string };
  integrity: { valid: boolean; code?: string; error?: string };
  revision: string | null;
  manifest: Record<string, unknown> | null;
}

export interface PolicyBundleDiffSection {
  create: string[];
  update: Array<{ name: string; changed: string[] }>;
  /** On the instance, absent from the bundle. ABAC policies are deleted only with `prune`; FGA stores never. */
  absent: string[];
  unchanged: number;
}

export interface PolicyBundleDiff {
  abac_policies: PolicyBundleDiffSection;
  fga_stores: PolicyBundleDiffSection;
  abac_templates: PolicyBundleDiffSection;
  abac_links: PolicyBundleDiffSection;
  /** `absent`: the instance has a schema and the bundle does not (removed only with `prune`). */
  abac_schema: 'create' | 'update' | 'absent' | 'unchanged';
  identical: boolean;
}

export interface PolicyBundleImport {
  object: 'policy_bundle_import';
  dry_run: boolean;
  applied: boolean;
  prune: boolean;
  revision: string;
  diff: PolicyBundleDiff;
}

const toBase64 = (b: string | Uint8Array): string =>
  typeof b === 'string' ? b : btoa(Array.from(b, (c) => String.fromCharCode(c)).join(''));

export function policyBundlesResource(request: RequestFn) {
  const upload = (u: PolicyBundleUpload) => ({ ...u, bundle: toBase64(u.bundle) });
  return {
    /** The stored bundles, newest first (without archives). */
    list(): Promise<{ object: 'list'; data: PolicyBundle[]; has_more: boolean }> {
      return request({ method: 'GET', path: '/v1/policy_bundles' });
    },
    /** The revision the instance policy is at right now — compare with a deployed bundle's to detect drift. */
    current(): Promise<{ object: 'policy_bundle_revision'; revision: string }> {
      return request({ method: 'GET', path: '/v1/policy_bundles/current' });
    },
    /** Export the current policy as a signed bundle. */
    export(): Promise<PolicyBundle> {
      return request({ method: 'POST', path: '/v1/policy_bundles' });
    },
    get(revision: string): Promise<PolicyBundle> {
      return request({ method: 'GET', path: `/v1/policy_bundles/${enc(revision)}` });
    },
    /** Check a bundle's signature and integrity on Atlas. */
    verify(body: PolicyBundleUpload): Promise<PolicyBundleVerification> {
      return request({ method: 'POST', path: '/v1/policy_bundles/verify', body: upload(body) });
    },
    /**
     * Import a signed bundle. `dryRun` returns what would change and applies
     * nothing; a real import applies everything in one transaction. A bundle whose
     * signature or integrity fails is refused with 422 before anything changes.
     */
    import(body: PolicyBundleUpload & { dry_run?: boolean; prune?: boolean }): Promise<PolicyBundleImport> {
      return request({ method: 'POST', path: '/v1/policy_bundles/import', body: upload(body) });
    },
  };
}
