/**
 * Type-level assignability checks, run by `pnpm typecheck` (tsc --noEmit). No
 * runtime assertions — the file exists purely so the compiler proves the public
 * surface stays shaped the way an integrator depends on. Kept self-contained
 * (no SDK imports) so `@atlasauth/types` is verified standalone.
 */
import type {
  SessionClaims,
  AuthzClaims,
  ProtectCondition,
  ProtectOutcome,
  ProtectReason,
  VerifiedSessionClaims,
  AuthorizedSession,
  VerifyResult,
  Metadata,
  CursorPage,
  DataList,
  CursorParams,
  DeletedObject,
  User,
  EmailAddress,
  Session,
  Organization,
  OrganizationMembership,
  Invitation,
  ApiKey,
  ApiKeyVerification,
  WebhookEvent,
  WebhookPayload,
  WebhookVerifyResult,
  WebhookVerifyFailure,
  Appearance,
  DesignTokens,
  ElementKey,
  LocalizationResource,
  Localization,
  DeepPartial,
} from './index';

/** Assert `T` is exactly assignable in both directions to the inferred value. */
declare function expectType<T>(value: T): void;

// --- session ---------------------------------------------------------------
const session: SessionClaims = { iss: 'i', sub: 'u', sid: 's', sv: 1, mfa: false };
expectType<string>(session.iss);
expectType<unknown>(session.anyCustomClaim); // index signature

// --- authz -----------------------------------------------------------------
const claims: AuthzClaims = { org_id: 'o', org_role: 'org:admin', org_permissions: ['read'] };
expectType<AuthzClaims>(claims);
const condition: ProtectCondition = { permission: 'posts:read', plan: 'pro' };
expectType<ProtectCondition>(condition);
const reason: ProtectReason = 'missing_entitlement';
expectType<ProtectReason>(reason);
const outcome: ProtectOutcome = { allowed: false, reason: 'signed_out' };
expectType<ProtectOutcome>(outcome);

// A mint-side SessionClaims structurally satisfies the authz view.
const asAuthz: AuthzClaims = session as unknown as AuthzClaims;
expectType<AuthzClaims>(asAuthz);

// --- verify ----------------------------------------------------------------
const verified: VerifiedSessionClaims = { iss: 'i', sub: 'u', sid: 's', exp: 1 };
expectType<number>(verified.exp);
declare const result: VerifyResult;
if (result.ok) {
  expectType<AuthorizedSession>(result);
  expectType<VerifiedSessionClaims>(result.claims);
  expectType<boolean>(result.has({ role: 'org:admin' }));
  expectType<VerifiedSessionClaims>(result.protect());
  expectType<{ sub: string } | null>(result.actor);
} else {
  expectType<'malformed' | 'invalid' | 'no_keys' | 'unauthorized_party'>(result.reason);
}

// --- resources -------------------------------------------------------------
const meta: Metadata = { any: 1 };
expectType<Metadata>(meta);
const user: User = {
  object: 'user',
  id: 'user_1',
  username: null,
  first_name: null,
  last_name: null,
  image_url: null,
  public_metadata: {},
  mfa_enabled: false,
  banned: false,
  locked: false,
  last_sign_in_at: null,
  created_at: 0,
  updated_at: 0,
};
expectType<'user'>(user.object);
const page: CursorPage<User> = { data: [user], has_more: false, next_cursor: null };
expectType<User[]>(page.data);
const list: DataList<EmailAddress> = { data: [] };
expectType<EmailAddress[]>(list.data);
const params: CursorParams = { limit: 10, starting_after: 'user_1' };
expectType<CursorParams>(params);
const deleted: DeletedObject = { object: 'user', id: 'user_1', deleted: true };
expectType<true>(deleted.deleted);
declare const org: Organization;
expectType<'organization'>(org.object);
declare const membership: OrganizationMembership;
expectType<'organization_membership'>(membership.object);
declare const invitation: Invitation;
expectType<'invitation'>(invitation.object);
declare const apiKey: ApiKey;
expectType<string>(apiKey.prefix);
declare const verification: ApiKeyVerification;
if (verification.valid) expectType<string>(verification.subject_id);
declare const atlasSession: Session;
expectType<string | null>(atlasSession.impersonated_by);

// --- webhooks --------------------------------------------------------------
const event: WebhookEvent = 'user.created';
expectType<WebhookEvent>(event);
// @ts-expect-error — not a real event name.
const notAnEvent: WebhookEvent = 'user.exploded';
void notAnEvent;
const payload: WebhookPayload<User> = {
  id: 'evt_1',
  type: 'user.created',
  timestamp: 0,
  instance_id: 'ins_1',
  data: user,
};
expectType<User>(payload.data);
const whResult: WebhookVerifyResult<WebhookPayload<User>> = { verified: false, reason: 'stale_timestamp' };
expectType<WebhookVerifyResult<WebhookPayload<User>>>(whResult);
const whFailure: WebhookVerifyFailure = 'signature_mismatch';
expectType<WebhookVerifyFailure>(whFailure);

// --- appearance ------------------------------------------------------------
const tokens: DesignTokens = { colorPrimary: '#000' };
expectType<DesignTokens>(tokens);
const elementKey: ElementKey = 'formButtonPrimary';
expectType<ElementKey>(elementKey);
const appearance: Appearance = {
  baseTheme: 'neobrutalist',
  variables: tokens,
  elements: { formButtonPrimary: 'rounded-xl' },
};
expectType<Appearance>(appearance);

// --- localization ----------------------------------------------------------
declare const resource: LocalizationResource;
expectType<string>(resource.locale);
expectType<string>(resource['signIn.title']);
const partial: Localization = { 'signIn.title': 'Connexion' };
expectType<Localization>(partial);
type MaybePartial = DeepPartial<{ a: { b: string } }>;
const dp: MaybePartial = { a: {} };
expectType<MaybePartial>(dp);
