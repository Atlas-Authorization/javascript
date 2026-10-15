<script lang="ts">
  import type {
    CaptchaController,
    FieldError,
    InstanceSettings,
    PublicSignUpField,
  } from '@atlasauth/js';
  import { useAtlas } from '../context';
  import { classFor, type ElementKey } from '../appearance';
  import { translate } from '../i18n';
  import CaptchaSlot from './CaptchaSlot.svelte';

  /**
   * The create-account step of `<SignUp/>`: the instance's configured extra
   * fields, email + password, the legal-consent row and — when the instance
   * requires one on sign-up — the captcha widget. Values live in local state so
   * a refused submit never clears them.
   *
   * When the app cannot send email (`settings.emailDelivery.passwordSignUp` is
   * false) an email + password sign-up could never be verified, so the form is
   * replaced by a "can't send email" notice (`signUp.emailUnavailable`).
   */
  export let settings: InstanceSettings | null = null;
  export let busy = false;
  export let errors: FieldError[] = [];
  export let captcha: CaptchaController | null = null;
  export let onSubmit: (values: Record<string, string>, consent: boolean) => void;

  const atlas = useAtlas();
  const cls = (key: ElementKey, base: string) => classFor(key, atlas.appearance, base);
  const t = (key: string, vars?: Record<string, string>) => translate(atlas.catalog, key, vars);

  let values: Record<string, string> = {};
  let agreed = false;

  $: legal = settings?.legal;
  $: showLegal = !!legal && (!!legal.termsUrl || !!legal.privacyUrl);
  $: consentOk = !legal?.required || agreed;
  $: fields = settings?.signUpFields ?? [];
  $: emailUnavailable = settings?.emailDelivery?.passwordSignUp === false;

  const label = (f: PublicSignUpField) =>
    f.required ? f.label : t('signUp.optionalField', { label: f.label });
  const inputType = (f: PublicSignUpField) =>
    ['email', 'tel', 'url', 'number', 'date'].includes(f.type) ? f.type : 'text';
  // Same encoding as React, the embed widget and the hosted page: one value,
  // or a comma-joined list for multiselect.
  const picked = (key: string) => (values[key] ? values[key]!.split(', ') : []);
  function toggle(f: PublicSignUpField, option: string, on: boolean) {
    if (f.type === 'radio') values[f.key] = option;
    else {
      const current = picked(f.key);
      values[f.key] = (on ? [...current, option] : current.filter((p) => p !== option)).join(', ');
    }
  }

  function handleSubmit(event: Event) {
    event.preventDefault();
    if (!consentOk) return;
    onSubmit({ ...values }, legal?.required ? agreed : true);
  }
</script>

<div class={cls('card', 'atlas-card')}>
  <h1 class={cls('headerTitle', 'atlas-title')}>{t('signUp.title')}</h1>

  {#each errors.filter((e) => !e.param) as error (error.code)}
    <p class={cls('formFieldError', 'atlas-error')} role="alert">{error.message}</p>
  {/each}

  {#if emailUnavailable}
    <p class={cls('formFieldError', 'atlas-error')} role="alert">{t('signUp.emailUnavailable')}</p>
  {:else}
    <form on:submit={handleSubmit}>
      {#each fields as f (f.key)}
        {#if f.type === 'radio' || f.type === 'multiselect'}
          <!-- A choice group holds several inputs, so it can't sit inside one <label>. -->
          <div class={cls('formField', 'atlas-field')}>
            <span class={cls('formFieldLabel', 'atlas-field-label')}>{label(f)}</span>
            <span class="atlas-choices">
              {#each f.options as o (o)}
                <label class="atlas-choice">
                  <input
                    type={f.type === 'radio' ? 'radio' : 'checkbox'}
                    name={f.key}
                    value={o}
                    checked={picked(f.key).includes(o)}
                    on:change={(e) => toggle(f, o, e.currentTarget.checked)}
                  />
                  {o}
                </label>
              {/each}
            </span>
            {#each errors.filter((e) => e.param === f.key) as error (error.code)}
              <span class={cls('formFieldError', 'atlas-error')}>{error.message}</span>
            {/each}
          </div>
        {:else}
          <label class={cls('formField', 'atlas-field')}>
            <span class={cls('formFieldLabel', 'atlas-field-label')}>{label(f)}</span>
            {#if f.type === 'checkbox'}
              <input
                type="checkbox"
                name={f.key}
                checked={values[f.key] === 'true'}
                on:change={(e) => (values[f.key] = e.currentTarget.checked ? 'true' : '')}
              />
            {:else if f.type === 'select'}
              <select
                class={cls('formFieldInput', 'atlas-input')}
                name={f.key}
                value={values[f.key] ?? ''}
                required={f.required}
                on:change={(e) => (values[f.key] = e.currentTarget.value)}
              >
                <option value="">{f.placeholder ?? t('signUp.selectPlaceholder')}</option>
                {#each f.options as o (o)}
                  <option value={o}>{o}</option>
                {/each}
              </select>
            {:else if f.type === 'textarea'}
              <textarea
                class={cls('formFieldInput', 'atlas-input')}
                name={f.key}
                rows="3"
                value={values[f.key] ?? ''}
                required={f.required}
                placeholder={f.placeholder ?? undefined}
                on:input={(e) => (values[f.key] = e.currentTarget.value)}
              />
            {:else}
              <input
                class={cls('formFieldInput', 'atlas-input')}
                type={inputType(f)}
                name={f.key}
                value={values[f.key] ?? ''}
                required={f.required}
                placeholder={f.placeholder ?? undefined}
                on:input={(e) => (values[f.key] = e.currentTarget.value)}
              />
            {/if}
            {#each errors.filter((e) => e.param === f.key) as error (error.code)}
              <span class={cls('formFieldError', 'atlas-error')}>{error.message}</span>
            {/each}
          </label>
        {/if}
      {/each}

      <label class={cls('formField', 'atlas-field')}>
        <span class={cls('formFieldLabel', 'atlas-field-label')}>{t('signUp.emailLabel')}</span>
        <input
          class={cls('formFieldInput', 'atlas-input')}
          type="email"
          name="email"
          autocomplete="email"
          required
          value={values.email ?? ''}
          on:input={(e) => (values.email = e.currentTarget.value)}
        />
        {#each errors.filter((e) => e.param === 'email') as error (error.code)}
          <span class={cls('formFieldError', 'atlas-error')}>{error.message}</span>
        {/each}
      </label>

      <label class={cls('formField', 'atlas-field')}>
        <span class={cls('formFieldLabel', 'atlas-field-label')}>{t('signUp.passwordLabel')}</span>
        <input
          class={cls('formFieldInput', 'atlas-input')}
          type="password"
          name="password"
          autocomplete="new-password"
          required
          value={values.password ?? ''}
          on:input={(e) => (values.password = e.currentTarget.value)}
        />
        {#each errors.filter((e) => e.param === 'password') as error (error.code)}
          <span class={cls('formFieldError', 'atlas-error')}>{error.message}</span>
        {/each}
      </label>

      {#if showLegal && legal}
        <label class={cls('formField', 'atlas-consent')}>
          {#if legal.required}
            <input type="checkbox" name="consent" bind:checked={agreed} />
          {/if}
          <span class="atlas-text">
            {t(legal.required ? 'signUp.consentAgree' : 'signUp.consentNotice')}
            {#if legal.termsUrl}
              <a class="atlas-link" href={legal.termsUrl} target="_blank" rel="noopener noreferrer"
                >{t('signUp.terms')}</a
              >{/if}{#if legal.termsUrl && legal.privacyUrl}{' '}{t('signUp.and')}{' '}{/if}{#if legal.privacyUrl}
              <a class="atlas-link" href={legal.privacyUrl} target="_blank" rel="noopener noreferrer"
                >{t('signUp.privacy')}</a
              >{/if}.
          </span>
          {#each errors.filter((e) => e.param === 'consent') as error (error.code)}
            <span class={cls('formFieldError', 'atlas-error')}>{error.message}</span>
          {/each}
        </label>
      {/if}

      {#if captcha}
        <CaptchaSlot controller={captcha} />
      {/if}

      <button
        class={cls('formButtonPrimary', 'atlas-button')}
        disabled={busy || !consentOk}
        type="submit"
      >
        {t('signUp.submit')}
      </button>
    </form>
  {/if}
</div>
