/**
 * Typed shapes for settings and response fields the instance, OAuth and
 * integration reads return. They describe the values of
 * `instance.get().auth_config_resolved` and the related list items; every
 * field is optional because an older API omits what it does not know.
 */

export interface AgentFabricSettings {
  continuousEvaluation?: boolean;
  defaultDelegationTtlSeconds?: number;
  maxMfaAgeSeconds?: number | null;
  maxRiskLevel?: 'low' | 'medium' | 'high' | null;
  /** What happens to a delegation whose evaluation starts failing. */
  onFailure?: 'deny' | 'revoke';
}

export interface AttackProtectionSettings {
  disposableEmail?: { allowDomains?: string[]; extraDomains?: string[] };
  recoveryAbuse?: { perAccountPerHour?: number; perIpPerHour?: number };
  signUpAbuse?: { blockRiskAt?: number; perAsnPerHour?: number; perIpPerDay?: number; perIpPerHour?: number };
}

export interface ComplianceSettings {
  cookieConsent?: { honorDnt?: boolean; honorGpc?: boolean; repromptDays?: number };
  retention?: {
    deletionReminders?: number[];
    dsrDueDays?: number;
    ownershipTransfer?: 'off' | 'block' | 'require_action';
    requireFinalNotice?: boolean;
    /** How many times a `pre_user_deletion` Action may pause one scheduled deletion (0-10, default 1). */
    maxPauses?: number;
  };
}

export interface MfaSettings {
  push?: {
    context?: { showApp?: boolean; showIp?: boolean; showLocation?: boolean };
    denyStreak?: { lockMinutes?: number };
  };
  recovery?: {
    viaIdentityVerification?: { allowNeedsReview?: boolean; minBaselineAgeHours?: number; requireNewPassword?: boolean };
  };
}

export interface OAuthProviderSettings {
  advanced?: { googleTokenExchange?: { atlasClientIds?: string[]; hostedDomains?: string[] } };
  /** Localized consent text per scope: `descriptions: { en: '...' }`. */
  customScopes?: Array<{ name?: string; descriptions?: Record<string, string> }>;
  tokenLifetimes?: { sessionAbsoluteSeconds?: number; sessionIdleSeconds?: number };
}

export interface SessionSettings {
  deviceBoundSessions?: boolean;
  /** Put the advisory `risk` object in the session token. */
  includeRiskClaim?: boolean;
  /** Raises the absolute ceiling from 90 to 365 days. */
  longLived?: boolean;
  /** Let a signed-in native session mint a one-time link that opens a signed-in browser session. */
  browserHandoff?: boolean;
  nonPersistentAbsoluteMs?: number;
  nonPersistentIdleMs?: number;
}

/** `nativeApps` in `auth_config`: what a native client with no registered app may do, and limits on its sessions. */
export interface NativeAppsSettings {
  /** `refuse` (the production default), `device_bound` (the development default: a refresh token bound to a device key) or `allow`. */
  unregistered?: 'refuse' | 'device_bound' | 'allow';
  unregisteredSession?: { absoluteMs?: number; requireMfa?: boolean };
  [key: string]: unknown;
}

/** The settings of `auth_config_resolved` the typed client names; other keys pass through. */
export interface InstanceAuthConfigResolved {
  accountUx?: { passkeyAdoption?: { retirePasswords?: boolean; repromptDays?: number } };
  agentFabric?: AgentFabricSettings;
  appApproval?: { firstFactor?: boolean; stepUp?: boolean; ttlSeconds?: number; revealNoAccount?: boolean };
  attackProtection?: AttackProtectionSettings;
  changeFeed?: Record<string, unknown>;
  compliance?: ComplianceSettings;
  endUserApiKeys?: { orgKeyOnCreatorDeparture?: 'keep' | 'revoke'; restoreKeysOnUnban?: boolean };
  localization?: { requireFourEyes?: boolean; requireReview?: boolean };
  mfa?: MfaSettings;
  nativeApps?: NativeAppsSettings;
  oauthProvider?: OAuthProviderSettings;
  organizations?: { invitationRedirectUrl?: string | null };
  session?: SessionSettings;
  sessionBinding?: { requireAttestation?: boolean };
  [key: string]: unknown;
}

/** Extra list-item fields on dynamic-registration tokens, OAuth providers and clients. */
export interface InitialAccessTokenScope {
  allowed_grant_types?: string[] | null;
  max_clients?: number | null;
  default_status?: 'development' | 'in_review' | 'approved' | 'suspended';
}

export interface OAuthProviderNativeClients {
  /** Client ids of native apps that may use the provider's native sign-in. */
  native_client_ids?: string[];
}

export interface OAuthClientReviewFields {
  testers?: string[];
  approved_scopes?: string[];
  rate_limit_per_minute?: number | null;
}

export interface BrandingFavicon {
  /** `favicon_url` on the wire for the PATCH body, `faviconUrl` in the stored branding. */
  faviconUrl?: string;
  favicon_url?: string;
}

export interface RevokedTokensPageMeta {
  /** How long revoked rows are kept (seconds). */
  retention_seconds: number;
}

export interface ActionTestPause {
  /** Why a test paused (e.g. a challenge awaiting input). */
  pause_reason?: string | null;
}

export interface BeforeUserCreateHookState {
  pending_since?: number | null;
  last_test_error?: string | null;
}

export interface IntegrationReadFields {
  /** Fingerprint of the stored signing secret, never the secret. */
  secret_fingerprint?: string | null;
}

export interface RedeliverResultFields {
  /** Failed events whose retry was moved to now instead of being sent twice. */
  retries_brought_forward?: number;
}

export interface LocalizationAuthorship {
  authored_by?: string | null;
}
