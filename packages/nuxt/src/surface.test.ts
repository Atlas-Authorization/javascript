import { describe, expect, it } from 'vitest';
import * as vue from '@atlasauth/vue';
import { VUE_COMPONENTS, VUE_COMPOSABLES } from './surface';

/**
 * The module auto-imports/registers by NAME from `@atlasauth/vue`; a name that the
 * package does not export would only fail when an app first used it. These pin
 * that every surfaced name exists and that the policy-acceptance pieces are in.
 */
describe('the surfaced @atlasauth/vue names', () => {
  it('every composable and component is exported by @atlasauth/vue', () => {
    const exported = vue as unknown as Record<string, unknown>;
    for (const name of [...VUE_COMPOSABLES, ...VUE_COMPONENTS]) {
      expect(exported[name], name).toBeDefined();
    }
  });

  it('includes the policy-acceptance composables and components', () => {
    expect(VUE_COMPOSABLES).toEqual(expect.arrayContaining(['usePolicies', 'usePolicyState']));
    expect(VUE_COMPONENTS).toEqual(
      expect.arrayContaining(['PolicyConsent', 'PolicyClickwrap', 'PolicyAcceptStep', 'PolicyGate']),
    );
  });

  it('has no duplicates', () => {
    expect(new Set(VUE_COMPOSABLES).size).toBe(VUE_COMPOSABLES.length);
    expect(new Set(VUE_COMPONENTS).size).toBe(VUE_COMPONENTS.length);
  });
});
