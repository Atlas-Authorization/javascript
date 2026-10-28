export interface SessionClaims {
  sub: string;
  sid: string;
  exp: number;
  org_id?: string;
  org_slug?: string;
  org_role?: string;
  org_permissions?: string[];
  mfa?: boolean;
  [claim: string]: unknown;
}

export interface AtlasUser {
  id: string;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  image_url: string | null;
  public_metadata: Record<string, unknown>;
  unsafe_metadata: Record<string, unknown>;
  mfa_enabled: boolean;
  has_password: boolean;
  email_addresses?: Array<{
    id: string;
    email_address: string;
    verified: boolean;
    primary: boolean;
  }>;
  phone_numbers?: Array<{
    id: string;
    phone_number: string;
    verified: boolean;
    primary: boolean;
  }>;
}

export interface AtlasOrganizationMembership {
  role: string;
  organization: {
    id: string;
    name: string;
    slug: string;
    image_url: string | null;
  };
}

export interface AtlasSession {
  id: string;
  status: string;
  last_active_organization_id: string | null;
  /** On an impersonation session: who is acting (the token's `act` claim). */
  actor?: { sub: string } | null;
  /** On an impersonation session: the impersonator's own session that "return to admin" resumes, or null. */
  actor_session_id?: string | null;
}

/**
 * §commerce a purchasable plan (Clerk commerce). Mirrors the public
 * `/v1/client/billing/plans` view — no Stripe internals. `amount` is in the
 * currency's minor unit (cents); `interval` is the billing period.
 */
export interface AtlasBillingPlan {
  object: 'billing_plan';
  id: string;
  name: string;
  slug: string;
  interval: string;
  amount: number;
  currency: string;
  features: string[];
  audience: 'user' | 'org';
  /** The provider the plan is sold through (stripe, polar, dodo, creem, chargebee, autumn, commet). */
  provider?: string;
  /** `base` (the subject's main plan) or `addon` (bought alongside it). */
  kind?: 'base' | 'addon';
  pricing_model?: string;
  trial_days?: number | null;
  annual_available?: boolean;
  annual_amount?: string | null;
  /** A display-only promotion (label, percent_off | amount_off, ends_at, code). */
  promotion?: { label: string; percent_off?: number; amount_off?: number; ends_at?: number; code?: string } | null;
}

/** §commerce a stored Stripe invoice for the subject (billing history). */
export interface AtlasBillingInvoice {
  object: 'billing_invoice';
  id: string;
  number: string | null;
  status: string;
  amount_due: number;
  amount_paid: number;
  currency: string;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  period_start: number | null;
  period_end: number | null;
  created_at: number;
}

/** §commerce the subject's default card, read live from Stripe. */
export interface AtlasPaymentMethod {
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
}

/** §commerce the subject's current subscription (Clerk commerce). */
export interface AtlasBillingSubscription {
  object: 'billing_subscription';
  id?: string;
  subject_type: 'user' | 'org';
  subject_id?: string;
  /** null when the subject has never subscribed. */
  status: string | null;
  plan: AtlasBillingPlan | null;
  current_period_end?: number | null;
  /** Ends at current_period_end unless restored. */
  cancel_at_period_end?: boolean;
  interval?: 'month' | 'year' | null;
  /** A plan change scheduled for the end of the period. */
  scheduled_plan_id?: string | null;
  scheduled_change_at?: number | null;
  trial_end?: number | null;
  provider?: string;
  quantity?: number;
  canceled_at?: number | null;
  /** Free trial still available to this subject. */
  trial_eligible?: boolean;
  /**
   * Every subscription the subject holds — the base plan and any add-ons
   * (only on the subject read; the top-level fields are the primary one).
   */
  subscriptions?: AtlasBillingSubscription[];
}

/** §commerce a live feature check (`useBilling().check`). */
export interface AtlasFeatureCheck {
  object: 'billing_feature_check';
  feature: string;
  allowed: boolean;
  /** `provider`: asked live of Autumn/Commet; `atlas`: from the resolved entitlement. */
  source: 'provider' | 'atlas';
  provider: string | null;
  remaining: number | null;
  granted: number | null;
  usage: number | null;
  unlimited: boolean;
}

/**
 * §L1 one signed-in account in a multi-session client — an entry in
 * `useSessionList()`. Carries its own user so a switcher can render every
 * identity without an extra fetch. The active session is the first entry and
 * its `id` equals `useSession().session.id`.
 */
export interface AtlasSessionResource {
  object: 'session';
  id: string;
  status: string;
  last_active_organization_id: string | null;
  expire_at?: number;
  abandon_at?: number;
  /** Custom per-session data your backend attached (read-only on the client); null when none. */
  custom_data?: Record<string, unknown> | null;
  user: AtlasUser;
}
