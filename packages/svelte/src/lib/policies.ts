import { policyTranslator, type PolicyClasses, type PolicyT } from '@atlasauth/js';
import { useAtlas } from './context';
import { classFor } from './appearance';
import { translate } from './i18n';

/** The policy UI's translator (catalog, else the English policy strings) and class hooks, for the current Atlas context. */
export function usePolicyUi(): { t: PolicyT; classes: PolicyClasses } {
  const atlas = useAtlas();
  return {
    t: policyTranslator((key, vars) => translate(atlas.catalog, key, vars)),
    classes: {
      link: classFor('link', atlas.appearance, 'atlas-link'),
      text: classFor('text', atlas.appearance, 'atlas-text'),
      primaryButton: classFor('formButtonPrimary', atlas.appearance, 'atlas-button'),
      error: classFor('formFieldError', atlas.appearance, 'atlas-error'),
    },
  };
}
