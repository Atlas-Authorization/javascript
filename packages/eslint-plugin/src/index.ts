import type { TSESLint } from '@typescript-eslint/utils';
import awaitGetToken from './rules/await-get-token';
import noLeakedSecretKey from './rules/no-leaked-secret-key';
import noPublishableKeyLiteral from './rules/no-publishable-key-literal';
import requireWebhookVerify from './rules/require-webhook-verify';
import noUnverifiedJwtDecode from './rules/no-unverified-jwt-decode';
import noPublicEnvSecret from './rules/no-public-env-secret';

/** The npm package name; the conventional flat-config plugin key. */
const PLUGIN_NAME = '@atlasauth';
const VERSION = '0.1.0';

export const meta = {
  name: '@atlasauth/eslint-plugin',
  version: VERSION,
} as const;

export const rules = {
  'no-leaked-secret-key': noLeakedSecretKey,
  'no-publishable-key-literal': noPublishableKeyLiteral,
  'await-get-token': awaitGetToken,
  'require-webhook-verify': requireWebhookVerify,
  'no-unverified-jwt-decode': noUnverifiedJwtDecode,
  'no-public-env-secret': noPublicEnvSecret,
} satisfies Record<string, TSESLint.RuleModule<string, readonly unknown[]>>;

/** Severity each rule carries in the recommended preset. */
const recommendedRules = {
  [`${PLUGIN_NAME}/no-leaked-secret-key`]: 'error',
  [`${PLUGIN_NAME}/no-publishable-key-literal`]: 'warn',
  [`${PLUGIN_NAME}/await-get-token`]: 'warn',
  [`${PLUGIN_NAME}/require-webhook-verify`]: 'error',
  [`${PLUGIN_NAME}/no-unverified-jwt-decode`]: 'error',
  [`${PLUGIN_NAME}/no-public-env-secret`]: 'error',
} as const;

/** The plugin object, referenced by the flat `recommended` config below. */
const plugin = { meta, rules };

/**
 * Flat-config preset (ESLint 9 `eslint.config.js`):
 *
 *   import atlas from '@atlasauth/eslint-plugin';
 *   export default [atlas.recommended];
 */
export const recommended: TSESLint.FlatConfig.Config = {
  name: '@atlasauth/recommended',
  plugins: { [PLUGIN_NAME]: plugin },
  rules: { ...recommendedRules },
};

/**
 * Legacy `.eslintrc` preset:
 *
 *   { "plugins": ["@atlasauth"], "extends": ["plugin:@atlasauth/recommended"] }
 */
export const configs = {
  recommended: {
    plugins: [PLUGIN_NAME],
    rules: { ...recommendedRules },
  },
} as const;

export default { meta, rules, recommended, configs };
