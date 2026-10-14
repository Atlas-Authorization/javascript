import { ESLintUtils } from '@typescript-eslint/utils';

/**
 * The shared rule factory for the plugin. Every rule's `name` maps to a public
 * docs URL (user/integrator-facing — no internal paths).
 */
export const createRule = ESLintUtils.RuleCreator(
  (name) => `https://atlasauth.net/docs/eslint-plugin/rules/${name}`,
);
