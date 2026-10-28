import type { EnvStyle, VendorTransform } from './engine';
import authentik, { authentikEnv, authentikPackages } from './authentik';
import fusionauth, { fusionauthEnv, fusionauthPackages } from './fusionauth';
import hanko, { hankoEnv, hankoPackages } from './hanko';
import keycloak, { keycloakEnv, keycloakPackages } from './keycloak';
import logto, { logtoEnv, logtoPackages } from './logto';
import ory, { oryEnv, oryPackages } from './ory';
import supertokens, { supertokensEnv, supertokensPackages } from './supertokens';
import zitadel, { zitadelEnv, zitadelPackages } from './zitadel';

/**
 * The `--from` codemods for the open-source identity providers (Keycloak, Ory,
 * ZITADEL, Logto, SuperTokens, authentik, FusionAuth, Hanko), gathered here so
 * migrate.ts adds them with one spread per table.
 */
export const OSS_IDP_VENDORS = ['keycloak', 'ory', 'zitadel', 'logto', 'supertokens', 'authentik', 'fusionauth', 'hanko'] as const;
export type OssIdpVendor = (typeof OSS_IDP_VENDORS)[number];

interface OssIdpCodemod {
  transform: VendorTransform;
  /** npm packages that belong to the vendor (removed once the manual items are done). */
  packages: (name: string) => boolean;
  /** `.env` keys that belong to the vendor, with what replaces them. */
  env: (key: string, style: EnvStyle) => string | null;
  /** Command-line spellings besides the id. */
  aliases: readonly string[];
}

export const OSS_IDP_CODEMODS: Record<OssIdpVendor, OssIdpCodemod> = {
  keycloak: { transform: keycloak, packages: keycloakPackages, env: keycloakEnv, aliases: ['keycloak-js', 'red-hat-sso', 'rhsso', 'rhbk'] },
  ory: { transform: ory, packages: oryPackages, env: oryEnv, aliases: ['kratos', 'ory-kratos', 'hydra', 'ory-hydra', 'ory-network'] },
  zitadel: { transform: zitadel, packages: zitadelPackages, env: zitadelEnv, aliases: [] },
  logto: { transform: logto, packages: logtoPackages, env: logtoEnv, aliases: ['logto-io'] },
  supertokens: { transform: supertokens, packages: supertokensPackages, env: supertokensEnv, aliases: ['super-tokens'] },
  authentik: { transform: authentik, packages: authentikPackages, env: authentikEnv, aliases: ['goauthentik'] },
  fusionauth: { transform: fusionauth, packages: fusionauthPackages, env: fusionauthEnv, aliases: ['fusion-auth'] },
  hanko: { transform: hanko, packages: hankoPackages, env: hankoEnv, aliases: ['teamhanko', 'hanko-io'] },
};

/** Command-line spelling → vendor id. */
export const OSS_IDP_ALIASES: Record<string, OssIdpVendor> = Object.fromEntries(
  OSS_IDP_VENDORS.flatMap((v) => [[v, v] as const, ...OSS_IDP_CODEMODS[v].aliases.map((a) => [a, v] as const)]),
);

const pick = <K extends keyof OssIdpCodemod>(key: K) =>
  Object.fromEntries(OSS_IDP_VENDORS.map((v) => [v, OSS_IDP_CODEMODS[v][key]])) as Record<OssIdpVendor, OssIdpCodemod[K]>;
export const OSS_IDP_TRANSFORMS = pick('transform');
export const OSS_IDP_PACKAGES = pick('packages');
export const OSS_IDP_ENV = pick('env');
