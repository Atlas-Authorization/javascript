/**
 * Type registration. `atlas types generate` writes a file that augments this
 * interface with the keys your instance really has:
 *
 *   declare module '@atlasauth/types' {
 *     interface Register { permission: 'org:billing:manage' | 'org:docs:read'; }
 *   }
 *
 * Every SDK (`@atlasauth/react`, `@atlasauth/js`, `@atlasauth/backend`,
 * `@atlasauth/authz`) reads the aliases below, so `has({ permission })` and
 * `<Protect permission>` are checked against your keys. With no generated file
 * `Register` is empty and every alias falls back to its loose default
 * (`string`, `Record<string, unknown>`), so nothing changes for existing code.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface Register {}

type Registered<K extends string, Fallback> = Register extends Record<K, infer T> ? T : Fallback;

/** An organization permission key (`org:billing:manage`). */
export type PermissionKey = Registered<'permission', string>;
/** An organization role key (`org:admin`). */
export type OrgRoleKey = Registered<'orgRole', string>;
/** An app-level (instance-wide) role key. */
export type AppRoleKey = Registered<'appRole', string>;
/** An app-level permission key. */
export type AppPermissionKey = Registered<'appPermission', string>;
/** A billing plan slug (the `pla` claim). */
export type PlanKey = Registered<'plan', string>;
/** A billing feature key (an entry of the `fea` claim). */
export type FeatureKey = Registered<'feature', string>;
/** An OAuth scope name. */
export type ScopeKey = Registered<'scope', string>;
/** A webhook event type from the instance's catalog. */
export type WebhookEventKey = Registered<'webhookEvent', string>;
/** A third-party app event type declared by the instance. */
export type AppEventKey = Registered<'appEvent', string>;
/** An audit event action. */
export type AuditEventKey = Registered<'auditEvent', string>;
/** A fine-grained authorization object type. */
export type FgaTypeKey = Registered<'fgaType', string>;
/** A fine-grained authorization relation name. */
export type FgaRelationKey = Registered<'fgaRelation', string>;

/** Extra session claims (templates, opt-in claims) layered over a verified token's claims. */
export type RegisteredSessionClaims = Registered<'sessionClaims', unknown>;

/** The shape of each metadata bag (from the instance's metadata schema). */
export type UserPublicMetadata = Registered<'publicMetadata', Record<string, unknown>>;
export type UserUnsafeMetadata = Registered<'unsafeMetadata', Record<string, unknown>>;
export type UserPrivateMetadata = Registered<'privateMetadata', Record<string, unknown>>;
export type OrganizationPublicMetadata = Registered<'organizationPublicMetadata', Record<string, unknown>>;
export type OrganizationPrivateMetadata = Registered<'organizationPrivateMetadata', Record<string, unknown>>;
