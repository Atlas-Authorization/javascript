import type { MigrationBridgePreset } from './migration-presets';
import { AUTHENTIK_BRIDGE_PRESETS } from './migration-presets-g4/authentik';
import { FUSIONAUTH_BRIDGE_PRESETS } from './migration-presets-g4/fusionauth';
import { HANKO_BRIDGE_PRESETS } from './migration-presets-g4/hanko';
import { KEYCLOAK_BRIDGE_PRESETS } from './migration-presets-g4/keycloak';
import { LOGTO_BRIDGE_PRESETS } from './migration-presets-g4/logto';
import { ORY_BRIDGE_PRESETS } from './migration-presets-g4/ory';
import { SUPERTOKENS_BRIDGE_PRESETS } from './migration-presets-g4/supertokens';
import { ZITADEL_BRIDGE_PRESETS } from './migration-presets-g4/zitadel';

/**
 * Bridge presets for the open-source identity providers — Keycloak, Ory
 * (Kratos, Hydra, Ory Network), ZITADEL, Logto, SuperTokens, authentik,
 * FusionAuth and Hanko — one module per vendor under ./migration-presets-g4/,
 * each checked against the vendor's token documentation and a fixture token.
 * Registered (replacing the starters) at the end of migration-presets.ts; the
 * modules import only types from there, so there is no import cycle at runtime.
 */
export const G4_BRIDGE_PRESETS: readonly MigrationBridgePreset[] = [
  ...KEYCLOAK_BRIDGE_PRESETS,
  ...ORY_BRIDGE_PRESETS,
  ...ZITADEL_BRIDGE_PRESETS,
  ...LOGTO_BRIDGE_PRESETS,
  ...SUPERTOKENS_BRIDGE_PRESETS,
  ...AUTHENTIK_BRIDGE_PRESETS,
  ...FUSIONAUTH_BRIDGE_PRESETS,
  ...HANKO_BRIDGE_PRESETS,
];
