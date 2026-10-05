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
  user: AtlasUser;
}
