/**
 * `@atlasauth/backend/pca`: Proof-Carrying Authority (agentic auth), the offline
 * verifier and the framework-agnostic guard from `@atlasauth/pca` (>= 0.4.3:
 * default-deny `requirePCA`, audience binding, strict evidence parsing).
 *
 * A separate entry because `@atlasauth/pca` includes Node-only hardware
 * attestation code: the main `@atlasauth/backend` entry stays Edge-safe.
 * `@atlasauth/pca` is an optional peer dependency: `npm i @atlasauth/pca`.
 */
export { verifyPCActn, requirePCA, defaultExtract, memoryPcaStore } from '@atlasauth/pca';
export type {
  PcaVerdict,
  PcaContext,
  VerifyPCActnOptions,
  RequirePcaOptions,
  PcaGuardResult,
  PcaRequestLike,
  PcaStateStore,
} from '@atlasauth/pca';
