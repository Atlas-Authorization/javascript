<script lang="ts">
  import { onMount } from 'svelte';
  import { FapiClient, createEmailLinkConfirmation, localizedErrorMessage, type EmailLink, type FieldError } from '@atlasauth/js';
  import { useAtlas } from '../context';
  import { classFor, type ElementKey } from '../appearance';
  import { translate } from '../i18n';
  import { ATLAS_SVELTE_SDK } from '../version';

  /**
   * What `<SignIn>` / `<SignUp>` draw when opened from a mailed link: tries this
   * browser's stored secret, then asks for the code the starting tab shows. A
   * success signs nobody in here: the starting tab continues on its own.
   */
  export let link: EmailLink;

  const atlas = useAtlas();
  const cls = (key: ElementKey, base: string) => classFor(key, atlas.appearance, base);
  const t = (key: string) => translate(atlas.catalog, key);
  const errorText = (error: FieldError) => localizedErrorMessage(error, atlas.errorCatalog ?? atlas.catalog, atlas.catalog);
  const controller = createEmailLinkConfirmation(
    new FapiClient({ publishableKey: atlas.publishableKey, baseUrl: atlas.frontendApi, locale: atlas.locale, sdk: ATLAS_SVELTE_SDK }),
    link,
  );
  let state = controller.state;
  let code = '';
  onMount(() => {
    const stop = controller.subscribe((next) => (state = next));
    void controller.start();
    return stop;
  });
</script>

<div class={cls('card', 'atlas-card')} data-atlas="email-link" data-atlas-status={state.status}>
  <h1 class={cls('headerTitle', 'atlas-title')}>{t('link.title')}</h1>
  {#if state.status === 'needs_code'}
    <form on:submit|preventDefault={() => void controller.submitCode(code)}>
      <p class="atlas-text">{t('link.enterCodeHelp')}</p>
      <label class="atlas-field">
        <span>{t('link.codeLabel')}</span>
        <input class={cls('formFieldInput', 'atlas-input')} type="text" name="match_code" autocomplete="off" inputmode="numeric" required bind:value={code} />
      </label>
      {#each state.errors as error (error.code)}
        <p class={cls('formFieldError', 'atlas-error')} role="alert">{errorText(error)}</p>
      {/each}
      <button class={cls('formButtonPrimary', 'atlas-button')} type="submit" disabled={state.busy}>{t('link.confirm')}</button>
    </form>
  {:else}
    <p class="atlas-text" role="status" aria-live="polite">
      {t(state.status === 'confirmed' ? 'link.confirmed' : state.status === 'invalid' ? 'link.invalid' : 'link.checking')}
    </p>
  {/if}
  {#if state.resetUrl}
    <p class="atlas-text"><a class="atlas-link" data-atlas-reset-link="" href={state.resetUrl}>{t('signIn.forgotPassword')}</a></p>
  {/if}
</div>
