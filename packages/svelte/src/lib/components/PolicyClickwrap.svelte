<script lang="ts">
  import { injectPolicyStyles, mountPolicyClickwrap, type PolicyAcceptanceController } from '@atlasauth/js';
  import { usePolicyUi } from '../policies';

  /** The clickwrap sentence ("By continuing you agree to …") for `link`-mode policies, under the submit button. */
  export let controller: PolicyAcceptanceController;

  const ui = usePolicyUi();

  function host(node: HTMLElement, c: PolicyAcceptanceController) {
    injectPolicyStyles(node.ownerDocument);
    let current = c;
    let mounted = mountPolicyClickwrap(node, current, ui);
    return {
      update(next: PolicyAcceptanceController) {
        if (next === current) return;
        mounted.destroy();
        current = next;
        mounted = mountPolicyClickwrap(node, current, ui);
      },
      destroy() {
        mounted.destroy();
      },
    };
  }
</script>

<p use:host={controller} />
