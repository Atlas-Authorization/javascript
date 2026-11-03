/**
 * Typed webhook payloads. `AtlasWebhookEvent` is a discriminated union over
 * `type`, generated from the server's event schemas; narrow with a `switch`:
 *
 *   const { verified, event } = verifyWebhook({ body, headers, secret });
 *   if (verified && event?.type === 'organization_membership.updated') event.data.role_source;
 *
 * Payloads are open objects: a field added later arrives untyped rather than
 * breaking the parse. An event type newer than this package version is not in
 * the union; keep a `default:` branch.
 */
export * from './webhook-events.generated';

/**
 * Who manages an organization member's role (`role_source` on memberships and on
 * `organization_membership.updated`); `null` when none was recorded (joined by
 * invitation, or before sources were recorded).
 *
 * - `manual`: set through the API or dashboard; directory changes leave it alone.
 * - `scim`: the organization's SCIM groups / roles keep it in step.
 * - `sso:<connection id>`: the SSO connection's role mapping, on each sign-in.
 * - `ldap:<connection id>`: the organization's LDAP connection.
 * - `directory_sync`: an LDAP directory sync.
 */
export type RoleSource = 'manual' | 'scim' | 'directory_sync' | `sso:${string}` | `ldap:${string}`;
