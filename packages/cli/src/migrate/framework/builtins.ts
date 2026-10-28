import { ldapPlugin } from '../ldap/plugin';
import { oidcPlugin } from '../oidc/plugin';
import { oneLoginPlugin } from '../onelogin/plugin';
import { pingIdentityPlugin } from '../ping-identity/plugin';
import { samlPlugin } from '../saml/plugin';
import { userTablePlugin } from '../user-table/plugin';
import { auth0Plugin } from '../auth0/plugin';
import { clerkPlugin } from '../clerk/plugin';
import { descopePlugin } from '../descope/plugin';
import { kindePlugin } from '../kinde/plugin';
import { oktaPlugin } from '../okta/plugin';
import { FRAMEWORK_PLUGINS } from '../frameworks/plugins';
import { appwritePlugin } from '../appwrite/plugin';
import { azureAdB2cPlugin } from '../azure-ad-b2c/plugin';
import { cognitoPlugin } from '../cognito/plugin';
import { entraExternalIdPlugin } from '../entra-external-id/plugin';
import { firebasePlugin } from '../firebase/plugin';
import { nhostPlugin } from '../nhost/plugin';
import { pocketbasePlugin } from '../pocketbase/plugin';
import { supabasePlugin } from '../supabase/plugin';
import { authentikPlugin } from '../authentik/plugin';
import { fusionauthPlugin } from '../fusionauth/plugin';
import { hankoPlugin } from '../hanko/plugin';
import { keycloakPlugin } from '../keycloak/plugin';
import { logtoPlugin } from '../logto/plugin';
import { oryPlugin } from '../ory/plugin';
import { supertokensPlugin } from '../supertokens/plugin';
import { zitadelPlugin } from '../zitadel/plugin';
import { corbadoPlugin } from '../corbado/plugin';
import { fronteggPlugin } from '../frontegg/plugin';
import { magicPlugin } from '../magic/plugin';
import { propelauthPlugin } from '../propelauth/plugin';
import { stytchPlugin } from '../stytch/plugin';
import { userfrontPlugin } from '../userfront/plugin';
import { workosPlugin } from '../workos/plugin';
import { customPlugin } from './custom';
import { hasMigrationPlugin, registerMigrationPlugin } from './registry';

/**
 * The plugins `atlas migrate <vendor>` ships with. A vendor track adds one
 * line here (its plugin module lives under src/migrate/<vendor>/).
 */
const BUILT_IN_PLUGINS = [customPlugin, clerkPlugin, auth0Plugin, oktaPlugin, kindePlugin, descopePlugin, ...FRAMEWORK_PLUGINS, firebasePlugin, supabasePlugin, cognitoPlugin, azureAdB2cPlugin, entraExternalIdPlugin, appwritePlugin, pocketbasePlugin, nhostPlugin, keycloakPlugin, oryPlugin, zitadelPlugin, logtoPlugin, supertokensPlugin, authentikPlugin, fusionauthPlugin, hankoPlugin, workosPlugin, stytchPlugin, fronteggPlugin, propelauthPlugin, magicPlugin, userfrontPlugin, corbadoPlugin, pingIdentityPlugin, oneLoginPlugin, samlPlugin, oidcPlugin, ldapPlugin, userTablePlugin];

/** Register the built-in plugins (idempotent: an already registered vendor is left as it is). */
export function registerBuiltInPlugins(): void {
  for (const plugin of BUILT_IN_PLUGINS) if (!hasMigrationPlugin(plugin.vendor)) registerMigrationPlugin(plugin);
}
