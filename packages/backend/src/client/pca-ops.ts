import { enc, type RequestFn } from './request';

/** An opaque signed or structured object Atlas stores and returns as given. */
export type PcaRecord = Record<string, unknown>;
type Page = { limit?: number; starting_after?: string };
type List<T = PcaRecord> = { object?: string; data?: T[]; next_cursor?: string | null };

export interface PcaAuthority {
  verbs: string[];
  resources: string[];
  limits?: PcaRecord;
  expires_at?: number;
}
export interface PcaGrantSummary {
  object?: string;
  grant_ref?: string;
  status?: string;
  principal?: string;
  agent?: string;
  chain_digest?: string;
}
export interface PcaGrantListQuery extends Page {
  principal?: string;
  agent?: string;
  status?: 'active' | 'revoked';
  cursor?: string;
}
export interface PcaGrant {
  object?: string;
  grant_ref?: string;
  status?: string;
  grant?: PcaRecord;
  remaining_budget?: PcaRecord;
  revoked_capabilities?: number;
  revocation_epoch?: PcaRecord;
}
export interface PcaGrantRevokeResult {
  object?: string;
  revoked?: string[];
  revocation_epoch?: PcaRecord;
}
export interface PcaGrantAuthority {
  object?: string;
  grant_ref?: string;
  rev?: number;
  status?: string;
  authority?: PcaRecord;
  authority_digest?: string;
}
export interface PcaStepUpChallenge {
  object?: string;
  step_up_ref?: string;
  nonce?: string;
  expires_at?: string;
}
export interface PcaAmendBody {
  action: 'narrow' | 'merge' | 'replace';
  authority: PcaAuthority;
  sig?: string;
  signed_by?: 'holder' | 'principal';
  step_up_ref?: string;
  new_grant_ref?: string;
}
export interface PcaGrantAmendResult {
  object?: string;
  grant_ref?: string;
  rev?: number;
  created?: boolean;
  supersedes?: string;
  authority?: PcaRecord;
}
export interface PcaNeed {
  verb: string;
  resource: string;
  limits?: PcaRecord;
  adjustable?: boolean;
}
export interface PcaNeedRequest {
  object?: string;
  id?: string;
  grant_ref?: string;
  status?: string;
}
export interface PcaNeedApproveResult {
  object?: string;
  grant_ref?: string;
  supersedes?: string;
  authority?: PcaRecord;
}
export interface PcaBondAccount {
  object?: string;
  account?: string;
  balance?: number;
}
export interface PcaPendingVeto {
  at?: number;
  via?: string;
  by?: string;
  evidence?: string;
}
export interface PcaUndoRecord {
  object?: string;
  record?: PcaRecord;
  pending_veto?: PcaPendingVeto;
}
export interface PcaUndoVeto {
  object?: string;
  record_id?: string;
  grant_ref?: string;
  state?: string;
  ver?: number;
  window_end?: number;
  veto?: PcaPendingVeto & { token?: string };
}
export interface PcaWorkflowReceiptBody {
  grant_ref: string;
  workflow: PcaRecord;
  step: string;
  outcome: 'ok' | 'failed';
  params_digest: string;
  outputs: PcaRecord;
  receipts?: PcaRecord[];
}
export interface PcaPrincipalBody {
  principal_pub: string;
  subject_type: 'user' | 'org' | 'machine';
  subject_id: string;
}
export interface PcaPrincipal {
  object?: string;
  principal_pub?: string;
  subject_type?: string;
  subject_id?: string;
  status?: string;
}
export interface PcaGuardianRotation {
  object?: string;
  epoch?: number;
  public_key?: string;
  previous?: { epoch?: number; public_key?: string };
  keys?: PcaRecord[];
}
export interface PcaBeaconBody {
  beacon?: PcaRecord;
  scope?: string;
  validity_ms?: number;
}
export interface PcaBeacon {
  object?: string;
  beacon?: PcaRecord;
  beacon_ref?: string;
  issuer_kind?: 'principal' | 'operator';
}
export interface PcaIntentSchema {
  object?: string;
  digest?: string;
  aud?: string;
  version?: string;
  schema?: PcaRecord;
  anchor?: PcaRecord;
}

type Channel = 'push' | 'email' | 'sms' | 'ciba';
export interface PcaApproverEnrolmentBody {
  subject_type?: 'user' | 'org' | 'machine';
  subject_id?: string;
  approver_id?: string;
  member_id?: string;
  display_name?: string;
  email?: string;
  phone?: string;
  user_id?: string;
  channels?: Channel[];
}
export interface PcaEnrolment {
  object?: string;
  id?: string;
  enrolment_url?: string;
  expires_at?: string;
  approver_id?: string | null;
  member_id?: string | null;
  reviewer_id?: string;
}
/** An approver with its members, devices and quorum. */
export interface PcaApprover extends PcaRecord {
  id?: string;
  principal_pub?: string;
  subject_type?: 'user' | 'org' | 'machine';
  subject_id?: string;
  display_name?: string | null;
  quorum?: number;
  status?: 'active' | 'disabled';
  created_at?: string;
  members?: PcaRecord[];
}
export interface PcaApproverUpdateBody {
  quorum?: number;
  display_name?: string | null;
  status?: 'active' | 'disabled';
}
export interface PcaApproverMemberUpdateBody {
  channels?: Channel[];
  email?: string | null;
  phone?: string | null;
  display_name?: string | null;
  status?: 'active' | 'disabled';
}
export interface PcaApprovalChannels {
  push?: boolean;
  email?: boolean;
  sms?: boolean;
  slack?: boolean;
  webhook?: boolean;
}
export interface PcaApprovalSettings {
  object?: string;
  channels?: PcaApprovalChannels;
  default_member_channels?: string[];
  ciba?: unknown;
  slack_webhook_set?: boolean;
}
export interface PcaApprovalSettingsBody {
  channels?: PcaApprovalChannels;
  default_member_channels?: Channel[];
  ciba?: unknown;
  slack_webhook_url?: string | null;
  ciba_client_secret?: string | null;
}

export type PcaSourceKind = 'openapi' | 'mcp' | 'graphql' | 'grpc' | 'asyncapi' | 'jsonschema';
export type PcaSourceSchedule = 'off' | 'hourly' | 'daily';
export interface PcaRegistryChange {
  verb?: string;
  class?: 'equal' | 'narrow' | 'widen' | 'incomparable' | 'added' | 'removed' | 'deprecated';
  reasons?: string[];
  rules?: PcaRecord;
  reviewed?: boolean;
}
export interface PcaRegistryVersion {
  object?: string;
  ns?: string;
  version?: string;
  digest?: string;
  prev?: string | null;
  status?: 'active' | 'staged';
  published_by?: string;
  created_at?: string;
  changes?: PcaRegistryChange[];
}
export interface PcaRegistryPinResult {
  object?: string;
  ns?: string;
  active_version?: string;
  pinned?: boolean;
  changes?: PcaRegistryChange[];
}
export interface PcaRegistryDiff {
  ok: boolean;
  from: string;
  to: string;
  code?: string;
  message?: string;
  verbs?: string[];
  changes: PcaRegistryChange[];
}
export interface PcaActionSearchQuery extends Page {
  q?: string;
  state?: 'confirmed' | 'unconfirmed' | 'stale' | 'deprecated';
  ns?: string;
}
export interface PcaImportBody {
  ns: string;
  from: PcaSourceKind;
  url?: string;
  source?: string;
  verb?: string;
  track?: boolean;
  schedule?: PcaSourceSchedule;
}
export interface PcaImportResult {
  object?: string;
  imported?: number;
  verbs?: string[];
  todo?: Array<{ where?: string; code?: string; message?: string }>;
  source_id?: string;
}
/** A draft action in the review queue, with its review view, policy card and lint. */
export interface PcaDraft extends PcaRecord {
  verb?: string;
  ns?: string;
  origin?: 'import' | 'template' | 'sync' | 'edit';
  state?: 'authored' | 'unreviewed' | 'suggested' | 'confirmed' | 'stale';
}
export interface PcaDraftUpdateBody {
  title?: string;
  description?: string | null;
  effects?: string[];
  params?: PcaRecord;
  reversibility?: PcaRecord;
  compensates?: string | null;
  traits?: string[];
  rules?: PcaRecord | null;
}
export interface PcaDraftConfirmBody {
  attestation: {
    def_digest: string;
    traits_digest: string;
    facts_digest: string;
    final_traits: string[];
    dismissed: Array<{ trait?: string; reason?: string }>;
    reviewer_kid: string;
    ts: number;
    sig: string;
  };
  rules_review?: {
    verb?: string;
    def_digest?: string;
    rules_digest?: string;
    reviewer_kid?: string;
    ts?: number;
    sig?: string;
  };
  assertion: { credential_id: string; authenticatorData: string; clientDataJSON: string; signature: string };
}
export interface PcaSource {
  object?: string;
  id?: string;
  ns?: string;
  kind?: PcaSourceKind;
  uri?: string;
  verb?: string | null;
  schedule?: PcaSourceSchedule;
  last_synced_at?: string | null;
  next_run_at?: string | null;
  last_status?: 'ok' | 'changes' | 'error' | null;
  last_error?: string | null;
  failures?: number;
}
export interface PcaSourceSyncResult {
  object?: string;
  source_id?: string;
  ns?: string;
  entries?: Array<{ verb?: string; change?: 'added' | 'changed' | 'unchanged' | 'removed'; diff?: PcaRecord }>;
  needs_review?: boolean;
  drafted?: string[];
}
export interface PcaReviewer {
  object?: string;
  id?: string;
  kid?: string | null;
  pk?: string | null;
  display_name?: string | null;
  email?: string | null;
  user_id?: string | null;
  status?: 'pending' | 'active' | 'disabled';
  created_at?: string;
  credentials?: PcaRecord[];
}

/** Grant management, approvers, undo and the action registry on `/v1/pca/*`. */
export function pcaOpsResource(request: RequestFn) {
  return {
    grants: {
      /** List registered grants, filtered by principal, agent and status. Keyset pagination. */
      list(query?: PcaGrantListQuery): Promise<List<PcaGrantSummary>> {
        return request({ method: 'GET', path: '/v1/pca/grants', query: { ...query } });
      },
      /** Inspect a grant: its signed chain, remaining trust budget and the current signed revocation epoch. */
      get(grantRef: string): Promise<PcaGrant> {
        return request({ method: 'GET', path: `/v1/pca/grants/${enc(grantRef)}` });
      },
      /** Revoke a grant, or with `scope: 'agent'` every active grant of its principal and agent. Without the secret key, pass the principal's `principal_sig`. */
      revoke(grantRef: string, body: { principal_sig?: string } = {}, query?: { scope?: 'grant' | 'agent' }): Promise<PcaGrantRevokeResult> {
        return request({ method: 'DELETE', path: `/v1/pca/grants/${enc(grantRef)}`, body, query: { ...query } });
      },
      /** Enrol a grant into management with the principal's signed initial authority statement (once; afterwards use `amend`). */
      setAuthority(grantRef: string, body: { authority: PcaAuthority; sig: string }, idempotencyKey?: string): Promise<PcaGrantAuthority> {
        return request({ method: 'PUT', path: `/v1/pca/grants/${enc(grantRef)}/authority`, body, idempotencyKey });
      },
      /** Issue a single-use step-up challenge for a grant, valid for 5 minutes. */
      createStepUp(grantRef: string, idempotencyKey?: string): Promise<PcaStepUpChallenge> {
        return request({ method: 'POST', path: `/v1/pca/grants/${enc(grantRef)}/step-up`, body: {}, idempotencyKey });
      },
      /** Approve a step-up challenge with the principal's signature over the grant, challenge and nonce. Once. */
      approveStepUp(grantRef: string, challengeId: string, body: { sig: string }, idempotencyKey?: string): Promise<{ object?: string; step_up_ref?: string; approved?: boolean }> {
        return request({ method: 'POST', path: `/v1/pca/grants/${enc(grantRef)}/step-up/${enc(challengeId)}/approve`, body, idempotencyKey });
      },
      /** Amend a managed grant's authority (narrow, merge or replace). */
      amend(grantRef: string, body: PcaAmendBody, idempotencyKey?: string): Promise<PcaGrantAmendResult> {
        return request({ method: 'POST', path: `/v1/pca/grants/${enc(grantRef)}/amend`, body, idempotencyKey });
      },
      /** File typed needs against a grant. Nothing changes until the principal approves. */
      createNeeds(grantRef: string, body: { needs: PcaNeed[]; sig?: string }, idempotencyKey?: string): Promise<PcaNeedRequest> {
        return request({ method: 'POST', path: `/v1/pca/grants/${enc(grantRef)}/needs`, body, idempotencyKey });
      },
      /** A grant's need requests, optionally filtered by status. */
      listNeeds(grantRef: string, query?: Page & { status?: 'pending' | 'approved' | 'denied' }): Promise<List> {
        return request({ method: 'GET', path: `/v1/pca/grants/${enc(grantRef)}/needs`, query: { ...query } });
      },
    },
    needs: {
      /** Approve a need request with the principal's signature over the approved set. */
      approve(needId: string, body: { approved: PcaRecord[]; sig: string; step_up_ref?: string; new_grant_ref?: string }, idempotencyKey?: string): Promise<PcaNeedApproveResult> {
        return request({ method: 'POST', path: `/v1/pca/needs/${enc(needId)}/approve`, body, idempotencyKey });
      },
      /** Deny a need request with the principal's signature (or the secret key). */
      deny(needId: string, body: { sig?: string } = {}, idempotencyKey?: string): Promise<PcaNeedRequest> {
        return request({ method: 'POST', path: `/v1/pca/needs/${enc(needId)}/deny`, body, idempotencyKey });
      },
    },
    bondAccounts: {
      /** Credit a bond account. */
      create(body: { account: string; amount: number }, idempotencyKey?: string): Promise<PcaBondAccount> {
        return request({ method: 'POST', path: '/v1/pca/bond-accounts', body, idempotencyKey });
      },
      /** A bond account's balance (`account` is a principal public key, or `escrow`). */
      get(query: { account: string }): Promise<PcaBondAccount> {
        return request({ method: 'GET', path: '/v1/pca/bond-accounts', query: { ...query } });
      },
    },
    undo: {
      /** Store an undo record. */
      createRecord(body: { record: PcaRecord }, idempotencyKey?: string): Promise<PcaUndoRecord> {
        return request({ method: 'POST', path: '/v1/pca/undo/records', body, idempotencyKey });
      },
      /** A stored undo record and the veto waiting on it, if any. */
      getRecord(id: string): Promise<PcaUndoRecord> {
        return request({ method: 'GET', path: `/v1/pca/undo/records/${enc(id)}` });
      },
      /** Replace a stored undo record. */
      updateRecord(id: string, body: { record: PcaRecord }, idempotencyKey?: string): Promise<PcaUndoRecord> {
        return request({ method: 'PUT', path: `/v1/pca/undo/records/${enc(id)}`, body, idempotencyKey });
      },
      /** Pending vetoes on undo records. */
      listVetoes(query?: Page): Promise<List<PcaUndoVeto>> {
        return request({ method: 'GET', path: '/v1/pca/undo/vetoes', query: { ...query } });
      },
    },
    /** Record a workflow step receipt against a grant. */
    createWorkflowReceipt(body: PcaWorkflowReceiptBody, idempotencyKey?: string): Promise<{ object?: string; grant_ref?: string; receipt?: PcaRecord; receipts?: PcaRecord[] }> {
      return request({ method: 'POST', path: '/v1/pca/workflow-receipts', body, idempotencyKey });
    },
    /** Register a constitution for a grant. */
    createConstitution(body: { grant_ref: string; constitution: PcaRecord }, idempotencyKey?: string): Promise<PcaRecord & { grant_ref?: string; constitution_id?: string; registered_at?: string }> {
      return request({ method: 'POST', path: '/v1/pca/constitutions', body, idempotencyKey });
    },
    principals: {
      /** Enrol a principal public key bound to a user, organization or machine. */
      create(body: PcaPrincipalBody, idempotencyKey?: string): Promise<PcaPrincipal> {
        return request({ method: 'POST', path: '/v1/pca/principals', body, idempotencyKey });
      },
      /** The instance's enrolled principals. */
      list(query?: Page): Promise<List<PcaPrincipal>> {
        return request({ method: 'GET', path: '/v1/pca/principals', query: { ...query } });
      },
      /** Disable an enrolled principal: its verified grants are denied and no new one can be registered under it. */
      delete(principalPub: string): Promise<PcaPrincipal> {
        return request({ method: 'DELETE', path: `/v1/pca/principals/${enc(principalPub)}` });
      },
    },
    /** Rotate the guardian signing key. */
    rotateGuardian(idempotencyKey?: string): Promise<PcaGuardianRotation> {
      return request({ method: 'POST', path: '/v1/pca/guardian/rotate', body: {}, idempotencyKey });
    },
    /** Issue a liveness beacon. */
    createBeacon(body: PcaBeaconBody = {}, idempotencyKey?: string): Promise<PcaBeacon> {
      return request({ method: 'POST', path: '/v1/pca/beacons', body, idempotencyKey });
    },
    /** Remove the post-quantum pin of an identity. */
    deletePqPin(identity: string): Promise<{ object?: string; identity?: string; deleted?: boolean }> {
      return request({ method: 'DELETE', path: `/v1/pca/pq-pins/${enc(identity)}` });
    },
    intent: {
      /** Runtime observations recorded against an intent map, oldest first. Paginate with `after` = the previous `next_cursor`. */
      listMapObservations(digest: string, query?: Page & { after?: string }): Promise<List> {
        return request({ method: 'GET', path: `/v1/pca/intent/maps/${enc(digest)}/observations`, query: { ...query } });
      },
      /** Register an intent schema with its signing keys. */
      createSchema(body: { schema: PcaRecord; keys: PcaRecord[] }, idempotencyKey?: string): Promise<PcaIntentSchema> {
        return request({ method: 'POST', path: '/v1/pca/intent/schemas', body, idempotencyKey });
      },
    },
    approvers: {
      /** Create a single-use passkey enrolment link for an approver or member. */
      createEnrolment(body: PcaApproverEnrolmentBody, idempotencyKey?: string): Promise<PcaEnrolment> {
        return request({ method: 'POST', path: '/v1/pca/approvers/enrolments', body, idempotencyKey });
      },
      /** List passkey approvers with their members, devices and quorum. */
      list(query?: Page): Promise<List<PcaApprover>> {
        return request({ method: 'GET', path: '/v1/pca/approvers', query: { ...query } });
      },
      get(id: string): Promise<PcaApprover> {
        return request({ method: 'GET', path: `/v1/pca/approvers/${enc(id)}` });
      },
      /** Change an approver's quorum or display name, or disable it. */
      update(id: string, body: PcaApproverUpdateBody): Promise<PcaApprover> {
        return request({ method: 'PATCH', path: `/v1/pca/approvers/${enc(id)}`, body });
      },
      /** Change a member's notification channels, contact details or status. */
      updateMember(id: string, memberId: string, body: PcaApproverMemberUpdateBody): Promise<PcaApprover> {
        return request({ method: 'PATCH', path: `/v1/pca/approvers/${enc(id)}/members/${enc(memberId)}`, body });
      },
      /** Revoke a passkey: it can no longer approve. */
      deleteCredential(id: string, credentialId: string): Promise<PcaApprover> {
        return request({ method: 'DELETE', path: `/v1/pca/approvers/${enc(id)}/credentials/${enc(credentialId)}` });
      },
    },
    approvals: {
      /** Approval channel settings (secrets are reported as set or not set, never returned). */
      getSettings(): Promise<PcaApprovalSettings> {
        return request({ method: 'GET', path: '/v1/pca/approvals/settings' });
      },
      /** Update the approval channels, default member channels, Slack webhook and CIBA provider. Omitted fields are kept; null clears. */
      setSettings(body: PcaApprovalSettingsBody, idempotencyKey?: string): Promise<PcaApprovalSettings> {
        return request({ method: 'PUT', path: '/v1/pca/approvals/settings', body, idempotencyKey });
      },
    },
    actionRegistry: {
      /** Namespaces with their active version and counts, publisher and reviewer keys. */
      get(): Promise<PcaRecord & { registry_mode?: boolean; namespaces?: PcaRecord[]; publisher_keys?: PcaRecord[] }> {
        return request({ method: 'GET', path: '/v1/pca/action-registry' });
      },
      /** Pin a publisher key (kid and Ed25519 public key). */
      createPublisherKey(body: { kid: string; pk: string; display_name?: string }, idempotencyKey?: string): Promise<{ object?: string; kid?: string; pk?: string; display_name?: string | null }> {
        return request({ method: 'POST', path: '/v1/pca/action-registry/publisher-keys', body, idempotencyKey });
      },
      deletePublisherKey(kid: string): Promise<void> {
        return request({ method: 'DELETE', path: `/v1/pca/action-registry/publisher-keys/${enc(kid)}` });
      },
      /** Publish a signed pack as the next version of its namespace. 409 when it widens without a reviewer. */
      publishPack(body: { pack: PcaRecord; rules?: PcaRecord; traits?: PcaRecord }, idempotencyKey?: string): Promise<PcaRegistryVersion> {
        return request({ method: 'POST', path: '/v1/pca/action-registry/packs', body, idempotencyKey });
      },
      /** The version history of a namespace. */
      listVersions(ns: string, query?: Page): Promise<List<PcaRegistryVersion>> {
        return request({ method: 'GET', path: `/v1/pca/action-registry/namespaces/${enc(ns)}/versions`, query: { ...query } });
      },
      /** One stored version: pack, rules, traits, deprecated actions and changes. */
      getVersion(ns: string, version: string): Promise<PcaRegistryVersion & PcaRecord> {
        return request({ method: 'GET', path: `/v1/pca/action-registry/namespaces/${enc(ns)}/versions/${enc(version)}` });
      },
      /** The semantic diff between two stored versions, and whether the move needs a reviewer. */
      diff(ns: string, query: { from: string; to: string }): Promise<PcaRegistryDiff> {
        return request({ method: 'GET', path: `/v1/pca/action-registry/namespaces/${enc(ns)}/diff`, query: { ...query } });
      },
      /** Activate and pin a stored version: later publishes are staged. */
      pin(ns: string, body: { version: string }, idempotencyKey?: string): Promise<PcaRegistryPinResult> {
        return request({ method: 'PUT', path: `/v1/pca/action-registry/namespaces/${enc(ns)}/pin`, body, idempotencyKey });
      },
      /** Unpin a namespace: later publishes activate again. */
      unpin(ns: string): Promise<PcaRegistryPinResult> {
        return request({ method: 'DELETE', path: `/v1/pca/action-registry/namespaces/${enc(ns)}/pin` });
      },
      /** Search the active actions by text, state and namespace. */
      listActions(query?: PcaActionSearchQuery): Promise<List> {
        return request({ method: 'GET', path: '/v1/pca/action-registry/actions', query: { ...query } });
      },
      /** One action: policy card, effective profile, business rules and history. */
      getAction(verb: string): Promise<PcaRecord> {
        return request({ method: 'GET', path: `/v1/pca/action-registry/actions/${enc(verb)}` });
      },
      /** Import actions from an API description into drafts, optionally tracking the source. */
      import(body: PcaImportBody, idempotencyKey?: string): Promise<PcaImportResult> {
        return request({ method: 'POST', path: '/v1/pca/action-registry/imports', body, idempotencyKey });
      },
      /** The review queue, riskiest first. */
      listDrafts(query?: Page & { ns?: string }): Promise<List<PcaDraft>> {
        return request({ method: 'GET', path: '/v1/pca/action-registry/drafts', query: { ...query } });
      },
      getDraft(verb: string): Promise<PcaDraft> {
        return request({ method: 'GET', path: `/v1/pca/action-registry/drafts/${enc(verb)}` });
      },
      /** Edit a draft. Re-validated; any edit drops a confirmation and a rules review. */
      updateDraft(verb: string, body: PcaDraftUpdateBody): Promise<PcaDraft> {
        return request({ method: 'PATCH', path: `/v1/pca/action-registry/drafts/${enc(verb)}`, body });
      },
      /** Remove a draft from the review queue. */
      deleteDraft(verb: string): Promise<{ object?: string; verb?: string; deleted?: unknown }> {
        return request({ method: 'DELETE', path: `/v1/pca/action-registry/drafts/${enc(verb)}` });
      },
      /** Put an active action back into the review queue as a draft. */
      reviewAction(verb: string, idempotencyKey?: string): Promise<PcaDraft> {
        return request({ method: 'POST', path: `/v1/pca/action-registry/actions/${enc(verb)}/review`, body: {}, idempotencyKey });
      },
      /** Confirm a draft with a signed reviewer attestation and a passkey assertion. */
      confirmDraft(verb: string, body: PcaDraftConfirmBody, idempotencyKey?: string): Promise<PcaDraft> {
        return request({ method: 'POST', path: `/v1/pca/action-registry/drafts/${enc(verb)}/confirm`, body, idempotencyKey });
      },
      /** Publish a namespace's confirmed drafts as its next version. */
      publish(body: { ns: string; version?: string }, idempotencyKey?: string): Promise<PcaRegistryVersion> {
        return request({ method: 'POST', path: '/v1/pca/action-registry/publish', body, idempotencyKey });
      },
      /** Create a single-use reviewer enrolment link (24 hours). */
      createReviewerEnrolment(body: { display_name?: string; email?: string; user_id?: string } = {}, idempotencyKey?: string): Promise<PcaEnrolment> {
        return request({ method: 'POST', path: '/v1/pca/action-registry/reviewers/enrolments', body, idempotencyKey });
      },
      /** The reviewers who may confirm action definitions, with their keys and passkeys. */
      listReviewers(query?: Page): Promise<List<PcaReviewer>> {
        return request({ method: 'GET', path: '/v1/pca/action-registry/reviewers', query: { ...query } });
      },
      /** Remove a reviewer: its key is unpinned and every passkey revoked. */
      deleteReviewer(id: string): Promise<PcaReviewer> {
        return request({ method: 'DELETE', path: `/v1/pca/action-registry/reviewers/${enc(id)}` });
      },
      /** The tracked import sources, with their schedule and last sync. */
      listSources(query?: Page): Promise<List<PcaSource>> {
        return request({ method: 'GET', path: '/v1/pca/action-registry/sources', query: { ...query } });
      },
      /** Track a source for manual or scheduled sync. */
      createSource(body: { ns: string; from: PcaSourceKind; url: string; verb?: string; schedule?: PcaSourceSchedule }, idempotencyKey?: string): Promise<PcaSource> {
        return request({ method: 'POST', path: '/v1/pca/action-registry/sources', body, idempotencyKey });
      },
      /** Change a source's URL, verb or schedule. */
      updateSource(id: string, body: { url?: string; verb?: string; schedule?: PcaSourceSchedule }): Promise<PcaSource> {
        return request({ method: 'PATCH', path: `/v1/pca/action-registry/sources/${enc(id)}`, body });
      },
      /** Stop tracking a source; its drafts stay in the queue. */
      deleteSource(id: string): Promise<{ object?: string; id?: string; deleted?: unknown }> {
        return request({ method: 'DELETE', path: `/v1/pca/action-registry/sources/${enc(id)}` });
      },
      /** Sync a source now: added and changed operations become unreviewed drafts. */
      syncSource(id: string, idempotencyKey?: string): Promise<PcaSourceSyncResult> {
        return request({ method: 'POST', path: `/v1/pca/action-registry/sources/${enc(id)}/sync`, body: {}, idempotencyKey });
      },
      /** The starter packs (e-commerce, fintech, healthcare, SaaS admin, developer tools). */
      listTemplates(query?: Page): Promise<List> {
        return request({ method: 'GET', path: '/v1/pca/action-registry/templates', query: { ...query } });
      },
      /** Add a starter pack's actions to a namespace as drafts. Never confirmed. */
      applyTemplate(id: string, body: { ns?: string } = {}, idempotencyKey?: string): Promise<List<PcaDraft>> {
        return request({ method: 'POST', path: `/v1/pca/action-registry/templates/${enc(id)}/apply`, body, idempotencyKey });
      },
    },
  };
}
