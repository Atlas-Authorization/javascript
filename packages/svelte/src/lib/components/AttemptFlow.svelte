<script lang="ts">
  import { nextStep, type AttemptView, type FieldError } from '@atlasauth/js';
  import { useAtlas } from '../context';
  import { classFor, type ElementKey } from '../appearance';
  import { translate } from '../i18n';

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

  const atlas = useAtlas();
  const cls = (key: ElementKey, base: string) => classFor(key, atlas.appearance, base);
  const t = (key: string, vars?: Record<string, string>) => translate(atlas.catalog, key, vars);

  interface Field {
    name: string;
    labelKey: string;
    type: string;
  }

  let values: Record<string, string> = {};

  $: step = attempt ? nextStep(attempt) : ({ kind: 'collect_identifier' } as const);

  // The step → fields mapping, mirroring the React switch exactly.
  $: fields = ((): Field[] => {
    switch (step.kind) {
      case 'collect_identifier':
        return [{ name: 'identifier', labelKey: 'signIn.identifierLabel', type: 'email' }];
      case 'collect_first_factor':
        return [{ name: 'password', labelKey: 'signIn.passwordLabel', type: 'password' }];
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
      case 'collect_identifier':
      case 'collect_first_factor':
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

  $: showSubmit = step.kind !== 'done' && step.kind !== 'await_oauth' && message === null;

  function handleSubmit(event: Event) {
    event.preventDefault();
    onSubmit(values);
  }
</script>

<div class={cls('card', 'atlas-card')}>
  <h1 class={cls('headerTitle', 'atlas-title')}>{t(titleKey)}</h1>

  {#each errors.filter((e) => !e.param) as error (error.code)}
    <p class={cls('formFieldError', 'atlas-error')} role="alert">{error.message}</p>
  {/each}

  <form on:submit={handleSubmit}>
    {#if message !== null}
      <p>{message}</p>
    {:else}
      {#each fields as f (f.name)}
        <label class="atlas-field">
          <span>{t(f.labelKey)}</span>
          <input
            class={cls('formFieldInput', 'atlas-input')}
            type={f.type}
            value={values[f.name] ?? ''}
            on:input={(e) => (values[f.name] = e.currentTarget.value)}
          />
          {#each errors.filter((e) => e.param === f.name) as error (error.code)}
            <span class={cls('formFieldError', 'atlas-error')}>{error.message}</span>
          {/each}
        </label>
      {/each}
    {/if}

    {#if showSubmit}
      <button class={cls('formButtonPrimary', 'atlas-button')} disabled={busy} type="submit">
        {t('signIn.submit')}
      </button>
    {/if}
  </form>
</div>
