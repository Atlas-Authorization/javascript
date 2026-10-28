<script lang="ts">
  import { canDownloadRecoveryCodes, copyRecoveryCodes, downloadRecoveryCodes } from '@atlasauth/js';
  import { useAtlas } from '../context';
  import { classFor, type ElementKey } from '../appearance';
  import { translate } from '../i18n';

  /**
   * The recovery codes a mid-sign-in MFA enrolment came with, shown once before
   * the sign-in finishes: copy them, download them as a .txt file, then
   * "I've saved my codes" (`onSaved`) exchanges the ticket. The codes live only
   * in the flow's memory and are forgotten once saved.
   */
  export let codes: string[];
  export let busy = false;
  export let onSaved: () => void;

  const atlas = useAtlas();
  const cls = (key: ElementKey, base: string) => classFor(key, atlas.appearance, base);
  const t = (key: string) => translate(atlas.catalog, key);
  const canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard?.writeText;
  const canDownload = canDownloadRecoveryCodes();
  let copied = false;
  $: if (codes) copied = false;

  async function copy() {
    copied = await copyRecoveryCodes(codes);
  }
</script>

<div class={cls('card', 'atlas-card')} data-atlas="recovery-codes">
  <h1 class={cls('headerTitle', 'atlas-title')}>{t('mfa.recoveryCodesTitle')}</h1>
  <p class="atlas-text">{t('mfa.recoveryCodesHelp')}</p>
  <ul
    class="atlas-recovery-codes"
    data-atlas="recovery-codes-list"
    style="list-style:none;padding:0;margin:8px 0 12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;text-align:center"
  >
    {#each codes as code (code)}
      <li><code>{code}</code></li>
    {/each}
  </ul>
  <div class="atlas-alternatives">
    {#if canCopy}
      <button class={cls('formButtonSecondary', 'atlas-button-secondary')} type="button" data-atlas="recovery-codes-copy" on:click={() => void copy()}>
        {t('mfa.recoveryCodesCopy')}
      </button>
    {/if}
    {#if canDownload}
      <button
        class={cls('formButtonSecondary', 'atlas-button-secondary')}
        type="button"
        data-atlas="recovery-codes-download"
        on:click={() => downloadRecoveryCodes(codes)}
      >
        {t('mfa.recoveryCodesDownload')}
      </button>
    {/if}
  </div>
  {#if copied}
    <p class="atlas-text" aria-live="polite" data-atlas="recovery-codes-copied">{t('mfa.recoveryCodesCopied')}</p>
  {/if}
  <button class={cls('formButtonPrimary', 'atlas-button')} type="button" data-atlas="recovery-codes-saved" disabled={busy} on:click={onSaved}>
    {t('mfa.recoveryCodesSaved')}
  </button>
</div>
