<script lang="ts">
  import {
    localizedErrorMessage,
    nextStep,
    offeredFirstFactors,
    planFirstFactor,
    type AttemptView,
    type CaptchaController,
    type EmailDelivery,
    type FieldError,
  } from '@atlasauth/js';
  import { useAtlas } from '../context';
  import { classFor, type ElementKey } from '../appearance';
  import { translate } from '../i18n';
  import CaptchaSlot from './CaptchaSlot.svelte';

  /**
   * The server-driven flow shell — the Svelte peer of React's `AttemptFlow`.
   *
   * Every branch comes from `nextStep`, which is exhaustive (including the
   * `unknown` case, rendered as an honest message rather than nothing). This
   * component makes no decision about what comes next; it renders whatever
   * `status` the server returned.
   */
  export let attempt: AttemptView | null = null;
  export let busy = false;
  export let errors: FieldError[] = [];
  export let titleKey: string;
  export let onSubmit: (values: Record<string, string>) => void;
  /**
   * The sign-in captcha, drawn above the submit button on the identifier step
   * (an always-on sign-in captcha) and on the challenge step the server demands
   * with `needs_captcha`. Null when the flow draws none.
   */
  export let captcha: CaptchaController | null = null;
  /**
   * The instance's email-delivery facts (`settings.emailDelivery`). While the app
   * cannot send email the first-factor step offers no email code / link option.
   */
  export let emailDelivery: EmailDelivery | null = null;
  /**
   * Ask the server to email a sign-in code or link (`FlowController.prepare`).
   * Without it the first-factor step offers the password only.
   */
  export let onPrepare: ((strategy: EmailStrategy) => Promise<boolean>) | null = null;

  type EmailStrategy = 'email_code' | 'email_link';

  const atlas = useAtlas();
  const cls = (key: ElementKey, base: string) => classFor(key, atlas.appearance, base);
  const t = (key: string, vars?: Record<string, string>) => translate(atlas.catalog, key, vars);
  const errorText = (error: FieldError) =>
    localizedErrorMessage(error, atlas.errorCatalog ?? atlas.catalog, atlas.catalog);

  interface Field {
    name: string;
    labelKey: string;
    type: string;
  }

  let values: Record<string, string> = {};

  $: step = attempt ? nextStep(attempt) : ({ kind: 'collect_identifier' } as const);

  // The first factors to offer: the server's list, minus email code / link when
  // the app cannot deliver email (a capability of the app, never of the user).
  const strategyName = (s: unknown): string =>
    typeof s === 'string' ? s : String((s as { strategy?: unknown } | null)?.strategy ?? '');
  $: offered =
    step.kind === 'collect_first_factor'
      ? offeredFirstFactors(step.strategies.map(strategyName), emailDelivery)
      : [];
  $: emailOptions = onPrepare
    ? offered.filter((s): s is EmailStrategy => s === 'email_code' || s === 'email_link')
    : [];
  // A password field only when the server offers `password` (planFirstFactor).
  $: plan = planFirstFactor(offered);
  $: showPassword = offered.includes('password') || emailOptions.length === 0;

  // Which emailed factor was sent, for which attempt (a new attempt starts over).
  let prepared: { strategy: EmailStrategy; attemptId: string | null } | null = null;
  $: sent = prepared && prepared.attemptId === (attempt?.id ?? null) ? prepared.strategy : null;

  async function prepare(strategy: EmailStrategy) {
    if (!onPrepare) return;
    const attemptId = attempt?.id ?? null;
    if (await onPrepare(strategy)) prepared = { strategy, attemptId };
  }

  // With no password on offer, email the code (or link) as soon as the step
  // appears — once per attempt, so a failed send waits for the user's retry.
  let autoSentFor: string | null = null;
  $: if (
    step.kind === 'collect_first_factor' &&
    onPrepare &&
    plan.autoSend &&
    attempt?.id &&
    autoSentFor !== attempt.id &&
    sent === null
  ) {
    autoSentFor = attempt.id;
    void prepare(plan.autoSend);
  }
  $: sending = step.kind === 'collect_first_factor' && sent === null && !!onPrepare && !plan.password && emailOptions.length > 0;
  $: identifier = attempt?.identifier ?? '';

  function usePassword() {
    prepared = null;
    values = {};
  }

  // The step → fields mapping, mirroring the React switch exactly.
  $: fields = ((): Field[] => {
    switch (step.kind) {
      case 'collect_identifier':
        return [{ name: 'identifier', labelKey: 'signIn.identifierLabel', type: 'email' }];
      case 'collect_first_factor':
        if (sent === 'email_code') {
          return [{ name: 'code', labelKey: 'signIn.emailCodeLabel', type: 'text' }];
        }
        if (sending || sent === 'email_link') return [];
        return showPassword
          ? [{ name: 'password', labelKey: 'signIn.passwordLabel', type: 'password' }]
          : [];
      case 'collect_second_factor':
        return [{ name: 'code', labelKey: 'mfa.codeLabel', type: 'text' }];
      case 'enroll_second_factor':
        // Two codes, not one (§5.6): consecutive codes so a phone with a fast
        // clock fails here rather than on every sign-in afterwards.
        return [
          { name: 'code', labelKey: 'mfa.enrollFirstCodeLabel', type: 'text' },
          { name: 'secondCode', labelKey: 'mfa.enrollSecondCodeLabel', type: 'text' },
        ];
      case 'collect_email_code':
        return [{ name: 'code', labelKey: 'signIn.emailCodeLabel', type: 'text' }];
      case 'collect_new_password':
        return [{ name: 'password', labelKey: 'reset.newPasswordLabel', type: 'password' }];
      default:
        return [];
    }
  })();

  // Steps that show a message instead of inputs, and hide the submit button.
  $: message = (() => {
    switch (step.kind) {
      case 'await_oauth':
        return t('signIn.magicLinkSent');
      case 'done':
        return t('signIn.checkOtherTab');
      case 'restart':
        return t('error.generic');
      case 'collect_first_factor':
        return null;
      case 'collect_captcha':
      case 'collect_identifier':
      case 'collect_second_factor':
      case 'enroll_second_factor':
      case 'collect_email_code':
      case 'collect_new_password':
        return null;
      default:
        // A status this SDK version does not know. Saying so beats a blank box.
        return t('error.generic');
    }
  })();

  $: showSubmit =
    step.kind !== 'done' &&
    step.kind !== 'await_oauth' &&
    message === null &&
    // Only emailed factors on offer: the option buttons are the way forward.
    (step.kind !== 'collect_first_factor' || fields.length > 0);
  $: showEmailOptions =
    step.kind === 'collect_first_factor' && message === null && sent === null && emailOptions.length > 0 && !(sending && busy);
  $: showCaptcha = !!captcha && (step.kind === 'collect_identifier' || step.kind === 'collect_captcha');

  function handleSubmit(event: Event) {
    event.preventDefault();
    // The first-factor step sends only what is on screen, so a stale value from
    // the other method never picks the strategy.
    if (step.kind === 'collect_first_factor') {
      onSubmit(sent === 'email_code' ? { code: values.code ?? '' } : { password: values.password ?? '' });
      return;
    }
    onSubmit(values);
  }
</script>

<div class={cls('card', 'atlas-card')}>
  <h1 class={cls('headerTitle', 'atlas-title')}>{t(titleKey)}</h1>

  {#each errors.filter((e) => !e.param) as error (error.code)}
    <p class={cls('formFieldError', 'atlas-error')} role="alert">{errorText(error)}</p>
  {/each}

  <form on:submit={handleSubmit}>
    {#if message !== null}
      <p>{message}</p>
    {:else}
      {#if step.kind === 'collect_captcha'}
        <!-- §5 the server withheld the attempt until a captcha clears. Solving
             the widget resubmits the identifier on its own; the button retries. -->
        <p class="atlas-text">{t('captcha.prompt')}</p>
      {/if}
      {#if step.kind === 'collect_first_factor' && sent === 'email_code'}
        <p class="atlas-text" data-atlas-code-sent>{t('signIn.codeSentTo', { email: identifier })}</p>
      {/if}
      {#if step.kind === 'collect_first_factor' && sent === 'email_link'}
        <p class="atlas-text" data-atlas-link-sent>{t('signIn.linkSentTo', { email: identifier })}</p>
      {/if}
      {#if sending}
        <p class="atlas-text" aria-live="polite">{t('signIn.sending')}</p>
      {/if}
      {#each fields as f (f.name)}
        <label class="atlas-field">
          <span>{t(f.labelKey)}</span>
          <input
            class={cls('formFieldInput', 'atlas-input')}
            type={f.type}
            name={f.name}
            value={values[f.name] ?? ''}
            on:input={(e) => (values[f.name] = e.currentTarget.value)}
          />
          {#each errors.filter((e) => e.param === f.name) as error (error.code)}
            <span class={cls('formFieldError', 'atlas-error')}>{errorText(error)}</span>
          {/each}
        </label>
      {/each}
      {#if step.kind === 'collect_first_factor' && sent !== null}
        <button
          class={cls('formButtonSecondary', 'atlas-button-secondary')}
          type="button"
          data-atlas-resend
          disabled={busy}
          on:click={() => void prepare(sent)}
        >
          {t(sent === 'email_code' ? 'signIn.resendCode' : 'signIn.resendLink')}
        </button>
        {#if plan.password}
          <button
            class={cls('formButtonSecondary', 'atlas-button-secondary')}
            type="button"
            data-strategy="password"
            disabled={busy}
            on:click={usePassword}
          >
            {t('signIn.passwordOption')}
          </button>
        {/if}
      {/if}
      {#if showEmailOptions}
        {#each emailOptions as strategy (strategy)}
          <button
            class={cls('formButtonSecondary', 'atlas-button-secondary')}
            type="button"
            data-strategy={strategy}
            disabled={busy}
            on:click={() => void prepare(strategy)}
          >
            {t(strategy === 'email_code' ? 'signIn.emailCodeOption' : 'signIn.emailLinkOption')}
          </button>
        {/each}
      {/if}
    {/if}

    {#if showCaptcha && captcha}
      <CaptchaSlot controller={captcha} />
    {/if}

    {#if showSubmit}
      <button class={cls('formButtonPrimary', 'atlas-button')} disabled={busy} type="submit">
        {t('signIn.submit')}
      </button>
    {/if}
  </form>
</div>
