import { enc, type RequestFn } from './request';



export interface IgaListEligibilitiesQuery {
  /** Only this person. */
  user_id?: string;
  /** Only this entitlement (key or id). */
  entitlement?: string;
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type IgaListEligibilitiesResult = {
  object?: 'list';
  data?: ({
    object: 'iga_eligibility';
    id: string;
    user_id: string;
    entitlement_id: string;
    expires_at: number | null;
    created_by: string | null;
    /** Created (epoch ms). */
    created_at: number;
  })[];
  /** Whether another page follows the cursor. */
  has_more?: boolean;
  /** The cursor to pass as `starting_after` for the next page on a keyset-paginated list; null on the last page (and absent on lists that are not cursor-paginated). */
  next_cursor?: string | null;
};

export type IgaCreateEligibilityBody = {
  user_id: string;
  entitlement: string;
  expires_at?: number;
};

export type IgaCreateEligibilityResult = {
  object: 'iga_eligibility';
  id: string;
  user_id: string;
  entitlement_id: string;
  expires_at: number | null;
  created_by: string | null;
  /** Created (epoch ms). */
  created_at: number;
};

export type IgaDeleteEligibilityResult = {
  object?: 'iga_eligibility';
  id?: string;
  deleted?: true;
};

export interface IgaListActivationsQuery {
  /** Only this person. */
  user_id?: string;
  /** Only this entitlement. */
  entitlement?: string;
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type IgaListActivationsResult = {
  object?: 'list';
  data?: ({
    object: 'iga_activation';
    id: string;
    user_id: string;
    entitlement_id: string;
    justification: string | null;
    ticket_ref: string | null;
    duration_seconds: number;
    acr: string | null;
    grant_id: string | null;
    request_id: string | null;
    status: 'active' | 'ended' | 'pending_approval' | 'denied' | 'cancelled' | 'failed';
    /** Activated (epoch ms). */
    created_at: number;
    /** Ends (epoch ms). */
    ends_at: number;
  })[];
  /** Whether another page follows the cursor. */
  has_more?: boolean;
  /** The cursor to pass as `starting_after` for the next page on a keyset-paginated list; null on the last page (and absent on lists that are not cursor-paginated). */
  next_cursor?: string | null;
};

export type IgaCreateActivationBody = {
  user_id: string;
  entitlement: string;
  justification?: string;
  ticket_ref?: string;
  duration_seconds?: number;
};

export type IgaCreateActivationResult = {
  object: 'iga_activation';
  id: string;
  user_id: string;
  entitlement_id: string;
  justification: string | null;
  ticket_ref: string | null;
  duration_seconds: number;
  acr: string | null;
  grant_id: string | null;
  request_id: string | null;
  status: 'active' | 'ended' | 'pending_approval' | 'denied' | 'cancelled' | 'failed';
  /** Activated (epoch ms). */
  created_at: number;
  /** Ends (epoch ms). */
  ends_at: number;
};

export type IgaEndActivationResult = {
  object: 'iga_activation';
  id: string;
  user_id: string;
  entitlement_id: string;
  justification: string | null;
  ticket_ref: string | null;
  duration_seconds: number;
  acr: string | null;
  grant_id: string | null;
  request_id: string | null;
  status: 'active' | 'ended' | 'pending_approval' | 'denied' | 'cancelled' | 'failed';
  /** Activated (epoch ms). */
  created_at: number;
  /** Ends (epoch ms). */
  ends_at: number;
};

export interface IgaListBundlesQuery {
  /** Only this catalog. */
  catalog?: string;
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type IgaListBundlesResult = {
  object?: 'list';
  data?: ({
    object: 'iga_bundle';
    id: string;
    key: string;
    name: string;
    description: string | null;
    catalog: string | null;
    entitlement_ids: string[];
    form: {
      key: string;
      label: string;
      required?: boolean;
    }[];
    policy: {
      /** Only people with a verified email on these domains may request the bundle (a connected organization). */
      allowed_email_domains?: string[];
      /** Your own domains; requesters outside them are guests. */
      internal_email_domains?: string[];
      /** Access requested by a guest ends after this many days (needs internal_email_domains). */
      guest_expiry_days?: number;
      /** How long the access lasts for everyone. */
      duration_seconds?: number;
    };
    enabled: boolean;
    /** Created (epoch ms). */
    created_at: number;
    /** Updated (epoch ms). */
    updated_at: number;
  })[];
  /** Whether another page follows the cursor. */
  has_more?: boolean;
  /** The cursor to pass as `starting_after` for the next page on a keyset-paginated list; null on the last page (and absent on lists that are not cursor-paginated). */
  next_cursor?: string | null;
};

export type IgaCreateBundleBody = {
  key: string;
  name: string;
  description?: string;
  catalog?: string;
  /** Entitlement keys or ids (1 to 25). */
  entitlements: string[];
  form?: {
    key: string;
    label: string;
    required?: boolean;
  }[];
  policy?: {
    /** Only people with a verified email on these domains may request the bundle (a connected organization). */
    allowed_email_domains?: string[];
    /** Your own domains; requesters outside them are guests. */
    internal_email_domains?: string[];
    /** Access requested by a guest ends after this many days (needs internal_email_domains). */
    guest_expiry_days?: number;
    /** How long the access lasts for everyone. */
    duration_seconds?: number;
  };
  enabled?: boolean;
};

export type IgaCreateBundleResult = {
  object: 'iga_bundle';
  id: string;
  key: string;
  name: string;
  description: string | null;
  catalog: string | null;
  entitlement_ids: string[];
  form: {
    key: string;
    label: string;
    required?: boolean;
  }[];
  policy: {
    /** Only people with a verified email on these domains may request the bundle (a connected organization). */
    allowed_email_domains?: string[];
    /** Your own domains; requesters outside them are guests. */
    internal_email_domains?: string[];
    /** Access requested by a guest ends after this many days (needs internal_email_domains). */
    guest_expiry_days?: number;
    /** How long the access lasts for everyone. */
    duration_seconds?: number;
  };
  enabled: boolean;
  /** Created (epoch ms). */
  created_at: number;
  /** Updated (epoch ms). */
  updated_at: number;
};

export type IgaGetBundleResult = {
  object: 'iga_bundle';
  id: string;
  key: string;
  name: string;
  description: string | null;
  catalog: string | null;
  entitlement_ids: string[];
  form: {
    key: string;
    label: string;
    required?: boolean;
  }[];
  policy: {
    /** Only people with a verified email on these domains may request the bundle (a connected organization). */
    allowed_email_domains?: string[];
    /** Your own domains; requesters outside them are guests. */
    internal_email_domains?: string[];
    /** Access requested by a guest ends after this many days (needs internal_email_domains). */
    guest_expiry_days?: number;
    /** How long the access lasts for everyone. */
    duration_seconds?: number;
  };
  enabled: boolean;
  /** Created (epoch ms). */
  created_at: number;
  /** Updated (epoch ms). */
  updated_at: number;
};

export type IgaUpdateBundleBody = {
  key?: string;
  name?: string;
  description?: string;
  catalog?: string;
  /** Entitlement keys or ids (1 to 25). */
  entitlements?: string[];
  form?: {
    key: string;
    label: string;
    required?: boolean;
  }[];
  policy?: {
    /** Only people with a verified email on these domains may request the bundle (a connected organization). */
    allowed_email_domains?: string[];
    /** Your own domains; requesters outside them are guests. */
    internal_email_domains?: string[];
    /** Access requested by a guest ends after this many days (needs internal_email_domains). */
    guest_expiry_days?: number;
    /** How long the access lasts for everyone. */
    duration_seconds?: number;
  };
  enabled?: boolean;
};

export type IgaUpdateBundleResult = {
  object: 'iga_bundle';
  id: string;
  key: string;
  name: string;
  description: string | null;
  catalog: string | null;
  entitlement_ids: string[];
  form: {
    key: string;
    label: string;
    required?: boolean;
  }[];
  policy: {
    /** Only people with a verified email on these domains may request the bundle (a connected organization). */
    allowed_email_domains?: string[];
    /** Your own domains; requesters outside them are guests. */
    internal_email_domains?: string[];
    /** Access requested by a guest ends after this many days (needs internal_email_domains). */
    guest_expiry_days?: number;
    /** How long the access lasts for everyone. */
    duration_seconds?: number;
  };
  enabled: boolean;
  /** Created (epoch ms). */
  created_at: number;
  /** Updated (epoch ms). */
  updated_at: number;
};

export type IgaDeleteBundleResult = {
  object?: 'iga_bundle';
  id?: string;
  deleted?: true;
};

export type IgaRequestBundleBody = {
  user_id: string;
  requester_user_id?: string;
  justification?: string;
  /** Answers to the bundle form, by field key. */
  answers?: Record<string, unknown>;
};

export type IgaRequestBundleResult = {
  object: 'iga_bundle_request';
  bundle_id: string;
  user_id: string;
  results: ({
    entitlement_id: string;
    entitlement_key?: string | null;
    outcome: 'requested' | 'skipped' | 'failed';
    request_id?: string;
    status?: string;
    reason?: string;
  })[];
};

export type IgaImportEntitlementsBody = {
  source: 'groups' | 'app_roles';
};

export type IgaImportEntitlementsResult = {
  object: 'iga_import';
  source: string;
  created: string[];
  skipped: string[];
};

export interface IgaListCampaignTemplatesQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type IgaListCampaignTemplatesResult = {
  object?: 'list';
  data?: {
    object: 'iga_campaign_template';
    key: string;
    name: string;
    description: string;
    parameters: string[];
  }[];
  /** Whether another page follows the cursor. */
  has_more?: boolean;
  /** The cursor to pass as `starting_after` for the next page on a keyset-paginated list; null on the last page (and absent on lists that are not cursor-paginated). */
  next_cursor?: string | null;
};

export type IgaCreateCampaignFromTemplateBody = {
  template: 'inactive_users' | 'guest_access' | 'quarterly_review';
  name?: string;
  parameters?: Record<string, unknown>;
  recurrence?: Record<string, unknown>;
};

export type IgaCreateCampaignFromTemplateResult = {
  object: 'iga_campaign';
  id: string;
  name: string;
  description: string | null;
  scope_type: 'all' | 'entitlement' | 'app' | 'role' | 'group' | 'org';
  scope_ids: string[];
  reviewer_type: 'manager' | 'owner' | 'named';
  reviewer_ids: string[];
  status: 'draft' | 'scheduled' | 'active' | 'closed';
  due_at: number | null;
  reminder_days: number[];
  auto_revoke: boolean;
  stages: ({
    name?: string;
    reviewer_type: 'manager' | 'owner' | 'named';
    reviewer_ids?: string[];
  })[];
  recurrence: {
    /** Five-field cron, UTC. */
    cron: string;
    /** Each copy is due this many days after it starts (1 to 365). */
    due_in_days?: number;
  } | null;
  next_run_at: number | null;
  parent_campaign_id: string | null;
  item_filter: {
    /** Only grants of people who have not signed in for this many days. */
    inactive_days?: number;
    /** Only people whose verified email is NOT on these domains (guests, contractors). */
    exclude_email_domains?: string[];
  } | null;
  launched_at: number | null;
  closed_at: number | null;
  /** Created (epoch ms). */
  created_at: number;
};

export type IgaRunCampaignNowResult = {
  object: 'iga_campaign';
  id: string;
  name: string;
  description: string | null;
  scope_type: 'all' | 'entitlement' | 'app' | 'role' | 'group' | 'org';
  scope_ids: string[];
  reviewer_type: 'manager' | 'owner' | 'named';
  reviewer_ids: string[];
  status: 'draft' | 'scheduled' | 'active' | 'closed';
  due_at: number | null;
  reminder_days: number[];
  auto_revoke: boolean;
  stages: ({
    name?: string;
    reviewer_type: 'manager' | 'owner' | 'named';
    reviewer_ids?: string[];
  })[];
  recurrence: {
    /** Five-field cron, UTC. */
    cron: string;
    /** Each copy is due this many days after it starts (1 to 365). */
    due_in_days?: number;
  } | null;
  next_run_at: number | null;
  parent_campaign_id: string | null;
  item_filter: {
    /** Only grants of people who have not signed in for this many days. */
    inactive_days?: number;
    /** Only people whose verified email is NOT on these domains (guests, contractors). */
    exclude_email_domains?: string[];
  } | null;
  launched_at: number | null;
  closed_at: number | null;
  /** Created (epoch ms). */
  created_at: number;
};

export type IgaStopCampaignRecurrenceResult = {
  object: 'iga_campaign';
  id: string;
  name: string;
  description: string | null;
  scope_type: 'all' | 'entitlement' | 'app' | 'role' | 'group' | 'org';
  scope_ids: string[];
  reviewer_type: 'manager' | 'owner' | 'named';
  reviewer_ids: string[];
  status: 'draft' | 'scheduled' | 'active' | 'closed';
  due_at: number | null;
  reminder_days: number[];
  auto_revoke: boolean;
  stages: ({
    name?: string;
    reviewer_type: 'manager' | 'owner' | 'named';
    reviewer_ids?: string[];
  })[];
  recurrence: {
    /** Five-field cron, UTC. */
    cron: string;
    /** Each copy is due this many days after it starts (1 to 365). */
    due_in_days?: number;
  } | null;
  next_run_at: number | null;
  parent_campaign_id: string | null;
  item_filter: {
    /** Only grants of people who have not signed in for this many days. */
    inactive_days?: number;
    /** Only people whose verified email is NOT on these domains (guests, contractors). */
    exclude_email_domains?: string[];
  } | null;
  launched_at: number | null;
  closed_at: number | null;
  /** Created (epoch ms). */
  created_at: number;
};

export interface IgaListCampaignRecommendationsQuery {
  /** Only items this person may decide. */
  reviewer_user_id?: string;
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type IgaListCampaignRecommendationsResult = {
  object?: 'list';
  data?: ({
    object: 'iga_campaign_item';
    id: string;
    campaign_id: string;
    grant_id: string;
    user_id: string;
    entitlement_id: string;
    reviewer_user_id: string | null;
    decision: 'pending' | 'certified' | 'revoked';
    decided_by: string | null;
    decided_at: number | null;
    comment: string | null;
    revoked_applied: boolean;
    /** The review stage the item is at (0-based). It moves on when a stage certifies. */
    stage: number;
    stage_history: ({
      stage: number;
      stage_name: string | null;
      decision: string;
      decided_by: string | null;
      decided_at: number;
      comment: string | null;
    })[];
  } & {
    recommendation: {
      action: 'certify' | 'revoke' | 'review';
      reasons: string[];
      last_sign_in_at: number | null;
      granted_at: number;
    };
  })[];
  /** Whether another page follows the cursor. */
  has_more?: boolean;
  /** The cursor to pass as `starting_after` for the next page on a keyset-paginated list; null on the last page (and absent on lists that are not cursor-paginated). */
  next_cursor?: string | null;
};

/** Operations on `/v1/iga` (18). */
export function igaOpsResource(request: RequestFn) {
  return {
    /** People who may activate an entitlement (eligible assignments). */
    listEligibilities(query?: IgaListEligibilitiesQuery): Promise<IgaListEligibilitiesResult> {
      return request({ method: 'GET', path: '/v1/iga/eligibilities', query: { ...query } });
    },
    /** Make a person eligible for an entitlement: they hold nothing until they activate it. The entitlement needs `activation_rules`. `expires_at` ends the eligibility. */
    createEligibility(body: IgaCreateEligibilityBody, idempotencyKey?: string): Promise<IgaCreateEligibilityResult> {
      return request({ method: 'POST', path: '/v1/iga/eligibilities', body, idempotencyKey });
    },
    /** Remove an eligibility. Access already activated stays until it ends. */
    deleteEligibility(id: string): Promise<IgaDeleteEligibilityResult> {
      return request({ method: 'DELETE', path: `/v1/iga/eligibilities/${enc(id)}` });
    },
    /** The activation history, newest first, with each activation's live status. */
    listActivations(query?: IgaListActivationsQuery): Promise<IgaListActivationsResult> {
      return request({ method: 'GET', path: '/v1/iga/activations', query: { ...query } });
    },
    /** Activate eligible access for a person as an administrator (the MFA the entitlement asks for is waived and the activation is marked `admin`). Justification, ticket and duration limits still apply. With `require_approval` the entitlement's approval steps run first and the status is `pending_approval`. */
    createActivation(body: IgaCreateActivationBody, idempotencyKey?: string): Promise<IgaCreateActivationResult> {
      return request({ method: 'POST', path: '/v1/iga/activations', body, idempotencyKey });
    },
    /** End an activation now: closes the grant, or cancels the pending approval. */
    endActivation(id: string): Promise<IgaEndActivationResult> {
      return request({ method: 'POST', path: `/v1/iga/activations/${enc(id)}/end` });
    },
    /** List access bundles (packages of entitlements requested together). */
    listBundles(query?: IgaListBundlesQuery): Promise<IgaListBundlesResult> {
      return request({ method: 'GET', path: '/v1/iga/bundles', query: { ...query } });
    },
    /** Create a bundle: several catalog entitlements, request form fields, and a policy (who may ask, guest expiry). */
    createBundle(body: IgaCreateBundleBody, idempotencyKey?: string): Promise<IgaCreateBundleResult> {
      return request({ method: 'POST', path: '/v1/iga/bundles', body, idempotencyKey });
    },
    /** Read one bundle by id or key. */
    getBundle(id: string): Promise<IgaGetBundleResult> {
      return request({ method: 'GET', path: `/v1/iga/bundles/${enc(id)}` });
    },
    /** Change an access bundle, its entitlements, form fields or policy. */
    updateBundle(id: string, body: IgaUpdateBundleBody): Promise<IgaUpdateBundleResult> {
      return request({ method: 'PATCH', path: `/v1/iga/bundles/${enc(id)}`, body });
    },
    /** Delete a bundle (access already granted stays). */
    deleteBundle(id: string): Promise<IgaDeleteBundleResult> {
      return request({ method: 'DELETE', path: `/v1/iga/bundles/${enc(id)}` });
    },
    /** Request every entitlement of a bundle for a person. Each one follows its own approval steps and separation-of-duties rules; the response says which were requested, skipped (already held or pending) or failed. */
    requestBundle(id: string, body: IgaRequestBundleBody, idempotencyKey?: string): Promise<IgaRequestBundleResult> {
      return request({ method: 'POST', path: `/v1/iga/bundles/${enc(id)}/request`, body, idempotencyKey });
    },
    /** Add catalog entitlements (not requestable, no approval steps) for the groups or app roles that exist but are not in the catalog yet. */
    importEntitlements(body: IgaImportEntitlementsBody, idempotencyKey?: string): Promise<IgaImportEntitlementsResult> {
      return request({ method: 'POST', path: '/v1/iga/entitlements/import', body, idempotencyKey });
    },
    /** Ready-made access reviews: inactive users, guest and contractor access, and a quarterly two-stage review. */
    listCampaignTemplates(query?: IgaListCampaignTemplatesQuery): Promise<IgaListCampaignTemplatesResult> {
      return request({ method: 'GET', path: '/v1/iga/campaign_templates', query: { ...query } });
    },
    /** Create a campaign from a template. `parameters` fill the template (inactive_days; company_domains). */
    createCampaignFromTemplate(body: IgaCreateCampaignFromTemplateBody, idempotencyKey?: string): Promise<IgaCreateCampaignFromTemplateResult> {
      return request({ method: 'POST', path: '/v1/iga/campaigns/from_template', body, idempotencyKey });
    },
    /** Start a copy of a recurring campaign now, outside its schedule. */
    runCampaignNow(id: string): Promise<IgaRunCampaignNowResult> {
      return request({ method: 'POST', path: `/v1/iga/campaigns/${enc(id)}/run_now` });
    },
    /** Stop a recurring campaign. Copies already started are unaffected. */
    stopCampaignRecurrence(id: string): Promise<IgaStopCampaignRecurrenceResult> {
      return request({ method: 'POST', path: `/v1/iga/campaigns/${enc(id)}/stop_recurrence` });
    },
    /** The open review items with advice for the reviewer: revoke (no sign-in for 90 days, or none since the access was granted), review (held by few of the manager's other reports) or certify. Advice only. */
    listCampaignRecommendations(id: string, query?: IgaListCampaignRecommendationsQuery): Promise<IgaListCampaignRecommendationsResult> {
      return request({ method: 'GET', path: `/v1/iga/campaigns/${enc(id)}/recommendations`, query: { ...query } });
    },
  };
}
