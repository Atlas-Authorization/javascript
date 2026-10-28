<script lang="ts">
  import { injectPolicyStyles, mountPolicyConsent, type PolicyAcceptanceController } from '@atlasauth/js';
  import { usePolicyUi } from '../policies';

  /**
   * The checkbox-mode policies (terms, privacy, …): one combined checkbox or one
   * each, the names opening the document in an in-page viewer. The state lives in
   * the `controller` (`policies` of `signUp()`, or a `PolicyAcceptanceController`
   * of your own). The DOM is drawn by `@atlasauth/js`, shared with every SDK.
   */
  export let controller: PolicyAcceptanceController;

  const ui = usePolicyUi();

  function host(node: HTMLElement, c: PolicyAcceptanceController) {
    injectPolicyStyles(node.ownerDocument);
    let current = c;
    let mounted = mountPolicyConsent(node, current, ui);
    return {
      update(next: PolicyAcceptanceController) {
        if (next === current) return;
        mounted.destroy();
        current = next;
        mounted = mountPolicyConsent(node, current, ui);
      },
      destroy() {
        mounted.destroy();
      },
    };
  }
</script>

<div use:host={controller} />
