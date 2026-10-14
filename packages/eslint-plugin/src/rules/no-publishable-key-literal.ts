import { createRule } from '../util';

/** A hardcoded publishable key: pk_live_... or pk_test_... */
const PUBLISHABLE_KEY = /\bpk_(live|test)_/;

export default createRule({
  name: 'no-publishable-key-literal',
  meta: {
    type: 'suggestion',
    hasSuggestions: true,
    docs: {
      description: 'Discourage hardcoding an Atlas publishable key (pk_live_/pk_test_) in source.',
    },
    messages: {
      hardcoded:
        'Avoid hardcoding an Atlas publishable key (pk_live_/pk_test_). Read it from an environment variable (e.g. process.env.ATLAS_PUBLISHABLE_KEY) so keys differ per environment and are not baked into source control.',
      useEnv: 'Replace with process.env.ATLAS_PUBLISHABLE_KEY',
    },
    schema: [],
  },
  defaultOptions: [],
  create(context) {
    return {
      Literal(node) {
        if (typeof node.value !== 'string' || !PUBLISHABLE_KEY.test(node.value)) return;
        context.report({
          node,
          messageId: 'hardcoded',
          suggest: [
            {
              messageId: 'useEnv',
              fix: (fixer) => fixer.replaceText(node, 'process.env.ATLAS_PUBLISHABLE_KEY'),
            },
          ],
        });
      },
    };
  },
});
