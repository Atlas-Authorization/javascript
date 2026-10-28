<script lang="ts">
  import { localizedErrorMessage, type FieldError } from '@atlasauth/js';
  import { useAtlas } from '../context';
  import { classFor, type ElementKey } from '../appearance';
  import { translate } from '../i18n';

  /**
   * The passkey-only sign-up's last step: create the passkey. The server
   * creates the account only when this registration verifies.
   */
  export let busy = false;
  export let errors: FieldError[] = [];
  export let onCreate: () => void;

  const atlas = useAtlas();
  const cls = (key: ElementKey, base: string) => classFor(key, atlas.appearance, base);
  const t = (key: string) => translate(atlas.catalog, key);
  const errorText = (error: FieldError) =>
    localizedErrorMessage(error, atlas.errorCatalog ?? atlas.catalog, atlas.catalog);
</script>

<div class={cls('card', 'atlas-card')} data-atlas-passkey-sign-up="">
  <h1 class={cls('headerTitle', 'atlas-title')}>{t('signUp.title')}</h1>
  {#each errors as error (error.code)}
    <p class={cls('formFieldError', 'atlas-error')} role="alert">{errorText(error)}</p>
  {/each}
  <p class="atlas-text">{t('signUp.passkeyPrompt')}</p>
  <button class={cls('formButtonPrimary', 'atlas-button')} type="button" disabled={busy} on:click={() => onCreate()}>
    {t('signUp.passkeyCreate')}
  </button>
</div>
