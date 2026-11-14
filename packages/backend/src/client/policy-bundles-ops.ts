import { enc, type RequestFn } from './request';





/** Operations on `/v1/policy_bundles` (1). */
export function policyBundlesOpsResource(request: RequestFn) {
  return {
    /** Download a stored bundle as the raw tar.gz (`application/gzip`). The detached signature is in the `Atlas-Bundle-Signature` header, with `Atlas-Bundle-Revision` and `Atlas-Bundle-Key-Id`. */
    getArchive(revision: string): Promise<Uint8Array> {
      return request({ method: 'GET', path: `/v1/policy_bundles/${enc(revision)}/archive`, binary: true });
    },
  };
}
