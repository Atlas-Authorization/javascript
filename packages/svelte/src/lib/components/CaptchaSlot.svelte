<script lang="ts">
  import type { CaptchaController } from '@atlasauth/js';

  /**
   * The element a flow's captcha widget draws into (see `createCaptchaController`
   * in `@atlasauth/js`). The parent renders it only while the flow needs a
   * captcha; the action attaches / detaches the controller with the element.
   */
  export let controller: CaptchaController;

  function attach(node: HTMLElement, c: CaptchaController) {
    let current = c;
    current.attach(node);
    return {
      update(next: CaptchaController) {
        if (next === current) return;
        current.attach(null);
        current = next;
        current.attach(node);
      },
      destroy() {
        current.attach(null);
      },
    };
  }
</script>

<div class="atlas-captcha" data-atlas-captcha="" use:attach={controller} />
