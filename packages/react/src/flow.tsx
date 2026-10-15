import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import {
  flowNeedsCaptcha,
  mintNativeNonce,
  nativeSignIn,
  nextStep,
  offeredFirstFactors,
  renderGoogleOverlayButton,
  reportProviderUnavailable,
  startOauthRedirect,
  startOauthPopup,
  type AttemptView,
  type FieldError,
} from '@atlasauth/js';
import { useAtlas } from './AtlasProvider';
import {
  FapiClient,
  advance,
  flowFromPending,
  pollAttempt,
  shouldKeepPolling,
  type FlowState,
} from './fapi';
import { useClass, useClasses, useErrorText, useText } from './components-shared';
import { localizeCaptchaErrors, useCaptcha } from './captcha';

/**
 * §10.2 components.
 *
 * `<SignIn/>` and `<SignUp/>` are "full multi-step flows driven entirely by the
 * server-side attempt status". That phrase is the design: this file contains no
 * decision about what comes next. It renders whatever `status` the server
 * returned, via the exhaustive mapping in @atlasauth/js — so adding a step to the
 * flow is a server change, and a client that has not shipped yet degrades to a
 * visible "needs an update" rather than a blank screen.
 *
 * This module holds the shared flow shell (`<AttemptFlow>`), the driver hook
 * (`useFlow`) and the social sign-in buttons; `<SignIn>`/`<SignUp>` compose them
 * from their own sibling files.
 */

export interface FlowProps {
  /** Where to send the user once the flow completes. */
  afterUrl?: string;
  /**
   * Also show Google One-Tap above the "Sign in with Google" button. OFF by
   * default: the button alone (a user-initiated popup) converts better and never
   * surprises the user with an auto-prompt. One-Tap is a separate GSI call, so
   * this only adds it — the button is unaffected.
   */
  googleOneTap?: boolean;
  /**
   * §10 hide the panel's own title. The `<SignIn>`/`<SignUp>` card renders its
   * own heading; set this when your page already has a "Sign in" heading above
   * the panel, so the word doesn't appear twice.
   */
  hideTitle?: boolean;
  /**
   * §oauth popup mode — `"popup"` completes social/OIDC sign-in in a popup
   * (GSI-style: click, approve, it closes, you're signed in, the page never
   * navigates), falling back to a full redirect when the popup is blocked.
   * Defaults to the `<AtlasProvider oauthMode>` value, else `"redirect"`.
   */
  oauthMode?: 'popup' | 'redirect';
  /**
   * Fired once when a native (in-page) provider — today Google (GSI) — could not be
   * used and its button has fallen back to the redirect flow: the library was blocked
   * (`'script_blocked'`) or drew no button (`'not_rendered'`). The button keeps
   * working via redirect regardless; this is purely so your page can show honest copy
   * ("Google sign-in is blocked by your browser") without inspecting Atlas's DOM.
   */
  onProviderUnavailable?: (provider: string, reason: ProviderUnavailableReason) => void;
  /**
   * customer spec 4.5 — how the native Google sign-in button is rendered. This is
   * the spec's `appearance:"host"|"google"`; it is named `googleButton` (NOT
   * `appearance`) because `appearance` is already the THEMING prop on
   * `<AtlasProvider>`.
   *
   * - `'host'` (default, = today's behaviour): render the app's OWN styled button —
   *   themed by the `appearance` design tokens / `socialButton` element — with
   *   Google's real GSI button overlaid INVISIBLY on top. The user sees your
   *   button; the click lands on Google's, minting an id_token in-page (no secret,
   *   no redirect). Use this to keep one consistent button look across providers.
   * - `'google'`: render Google's OWN "Sign in with Google" GSI button, VISIBLY, in
   *   place of the styled host button. Google controls that button's look (you can't
   *   theme it); pick this if you'd rather not maintain a styled button at all.
   *
   * In BOTH modes the button still falls back to the ordinary redirect OAuth flow
   * (and fires {@link FlowProps.onProviderUnavailable}) if GSI is blocked or never
   * renders — a dead GSI is never a blank, unclickable surface. Stops teams
   * hand-rolling the invisible-overlay technique themselves.
   */
  googleButton?: GoogleButtonMode;
}

/**
 * The server-driven flow shell.
 *
 * Every branch comes from `nextStep`, which is exhaustive — including the
 * `unknown` case, which renders an honest message instead of nothing.
 */
export function AttemptFlow({
  attempt,
  onSubmit,
  busy,
  errors,
  titleKey,
  hideTitle,
  captcha,
}: {
  attempt: AttemptView | null;
  onSubmit(values: Record<string, string>): void;
  busy: boolean;
  errors: FieldError[];
  titleKey: string;
  hideTitle?: boolean;
  /**
   * The captcha widget slot (see `useCaptcha`), drawn above the submit button on
   * the identifier step (an always-on sign-in captcha) and on the challenge step
   * the server demands with `needs_captcha`.
   */
  captcha?: ReactNode;
}) {
  const t = useText();
  const errorText = useErrorText();
  const { instanceSettings } = useAtlas();
  const cardClass = useClass('card', 'atlas-card');
  const titleClass = useClass('headerTitle', 'atlas-title');
  const inputClass = useClass('formFieldInput', 'atlas-input');
  const buttonClass = useClass('formButtonPrimary', 'atlas-button');
  const errorClass = useClass('formFieldError', 'atlas-error');
  const cls = useClasses();

  const [values, setValues] = useState<Record<string, string>>({});
  const step = attempt ? nextStep(attempt) : { kind: 'collect_identifier' as const };
  /**
   * The first factors this form may offer: the server's list, minus email code /
   * link while the app can't deliver email (a capability of the app, never a
   * per-identifier filter). When nothing is left there is no factor this form
   * can collect, so it says why instead of asking for a password.
   */
  const firstFactors =
    step.kind === 'collect_first_factor'
      ? offeredFirstFactors(step.strategies, instanceSettings?.emailDelivery)
      : [];
  const noFirstFactor =
    step.kind === 'collect_first_factor' && step.strategies.length > 0 && firstFactors.length === 0;

  const field = (name: string, labelKey: string, type = 'text') => (
    <label key={name} className={cls('formField', 'atlas-field')}>
      <span className={cls('formFieldLabel', 'atlas-field-label')}>{t(labelKey)}</span>
      <input
        className={inputClass}
        type={type}
        name={name}
        value={values[name] ?? ''}
        onChange={(event) => setValues((v) => ({ ...v, [name]: event.target.value }))}
      />
      {errors
        .filter((error) => error.param === name)
        .map((error) => (
          <span key={error.code} className={errorClass}>
            {errorText(error)}
          </span>
        ))}
    </label>
  );

  const fields = () => {
    switch (step.kind) {
      case 'collect_identifier':
        return [field('identifier', 'signIn.identifierLabel', 'email')];
      case 'collect_first_factor':
        if (noFirstFactor) {
          return [
            <p key="email-unavailable" className={errorClass} role="alert" data-atlas-email-unavailable="">
              {t('signUp.emailUnavailable')}
            </p>,
          ];
        }
        return [field('password', 'signIn.passwordLabel', 'password')];
      case 'collect_second_factor':
        return [field('code', 'mfa.codeLabel')];
      case 'enroll_second_factor':
        /**
         * Two codes, not one. §5.6 wants consecutive codes so a phone with a
         * fast clock fails here rather than on every sign-in afterwards, and
         * asking for one would hide that failure until it was expensive.
         */
        return [
          field('code', 'mfa.enrollFirstCodeLabel'),
          field('secondCode', 'mfa.enrollSecondCodeLabel'),
        ];
      case 'collect_email_code':
        return [field('code', 'signIn.emailCodeLabel')];
      case 'collect_new_password':
        return [field('password', 'reset.newPasswordLabel', 'password')];
      case 'collect_captcha':
        /**
         * §5 the server withheld the attempt until a captcha clears (an always-on
         * sign-in gate, or a risk-triggered challenge). The widget below yields
         * the token; solving it resubmits the identifier automatically, and the
         * button retries by hand.
         */
        return [
          <p key="captcha" className={cls('text', 'atlas-text')}>
            {t('captcha.prompt')}
          </p>,
        ];
      case 'await_oauth':
        return [<p key="oauth" className={cls('text', 'atlas-text')}>{t('signIn.magicLinkSent')}</p>];
      case 'done':
        return [<p key="done" className={cls('text', 'atlas-text')}>{t('signIn.checkOtherTab')}</p>];
      case 'restart':
        return [<p key="restart" className={cls('text', 'atlas-text')}>{t('error.generic')}</p>];
      default:
        /**
         * A status this SDK version does not know. Saying so beats rendering
         * nothing, which is a blank login box the user cannot act on.
         */
        return [
          <p key="unknown" className={errorClass}>
            {t('error.generic')}
          </p>,
        ];
    }
  };

  return (
    <div className={cardClass}>
      {hideTitle ? null : <h1 className={titleClass}>{t(titleKey)}</h1>}

      {errors
        .filter((error) => !error.param)
        .map((error) => (
          <p key={error.code} className={errorClass} role="alert">
            {errorText(error)}
          </p>
        ))}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(values);
        }}
      >
        {fields()}
        {step.kind === 'collect_identifier' || step.kind === 'collect_captcha' ? captcha : null}
        {step.kind !== 'done' && step.kind !== 'await_oauth' && !noFirstFactor ? (
          <button className={buttonClass} disabled={busy} type="submit">
            {t('signIn.submit')}
          </button>
        ) : null}
      </form>
    </div>
  );
}

/**
 * §10.2 `FlowProps.afterUrl` — the completion-redirect decision, pulled out as a
 * PURE function so it is unit-testable without a DOM (this package's tests are
 * pure-function). Returns the URL to navigate to once the flow completes, or
 * `null` to stay put. Unset or blank/whitespace is a no-op — today's behaviour.
 */
export function afterUrlTarget(afterUrl?: string): string | null {
  const trimmed = afterUrl?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Side-effecting companion to {@link afterUrlTarget}: navigate to `afterUrl` once
 * a flow has completed (and the provider has re-booted signed-in). No-op when
 * unset/blank or under SSR, so an unset `afterUrl` leaves the page exactly where
 * it was. Uses `location.assign` so a relative OR absolute URL both work.
 */
function navigateAfterComplete(afterUrl?: string): void {
  const target = afterUrlTarget(afterUrl);
  if (target && typeof window !== 'undefined') window.location.assign(target);
}

/**
 * Drives the flow through `advance`, which owns the step-to-endpoint mapping.
 * This component never decides what comes next — it renders the status the
 * server returned and posts whatever the driver says the current step needs.
 *
 * `afterUrl` (from {@link FlowProps}) is where to send the user once the flow
 * completes; it fires on EVERY completion path this hook owns (the step submit,
 * the native/popup social `onComplete`, and the cross-device poll), after the
 * session re-boot, so the destination page already sees a signed-in user.
 */
export function useFlow({
  afterUrl,
  signInCaptcha = true,
}: {
  afterUrl?: string;
  /**
   * Drive the sign-in captcha (always-on per-flow captcha and the server's
   * `needs_captcha` challenge). `<SignUp>` turns it off: its create step has its
   * own sign-up captcha, and it never posts a sign-in identifier.
   */
  signInCaptcha?: boolean;
} = {}) {
  const { publishableKey, frontendApi, locale, reload, pendingAttempt, instanceSettings, broadcastSessionChange } = useAtlas();
  const t = useText();
  // Seeded from a redirect that came back mid-flow (e.g. OAuth needing a second
  // factor), so the user resumes at the demanded step instead of starting over.
  const [state, setState] = useState<FlowState>(() => flowFromPending(pendingAttempt));

  /**
   * §5 the sign-in captcha. Drawn on the identifier step when the instance
   * ALWAYS requires one for sign-in (so the first POST already carries the
   * token), and on the `needs_captcha` challenge step the server answers with
   * when it withheld the attempt (always-on, or risk-triggered) — where solving
   * it resubmits the identifier on its own.
   */
  const signInFlow = signInCaptcha ? instanceSettings?.captchaFlows.signIn : undefined;
  const stepKind = state.attempt ? nextStep(state.attempt).kind : 'collect_identifier';
  const challenged = stepKind === 'collect_captcha';
  const identifierRef = useRef('');
  const submitRef = useRef<(values: Record<string, string>) => void>(() => undefined);
  const captcha = useCaptcha(signInFlow, {
    active: challenged || (stepKind === 'collect_identifier' && flowNeedsCaptcha(signInFlow)),
    // On the challenge step the widget is the only thing to do: draw it (even an
    // invisible one) straight away and continue once it is solved.
    eager: challenged ? true : undefined,
    onSolved: challenged ? () => submitRef.current({}) : undefined,
  });

  const client = useMemo(
    () => new FapiClient({ publishableKey, baseUrl: frontendApi, locale }),
    [frontendApi, publishableKey, locale],
  );

  // Apply a driver result to the UI, and — on completion — exchange the one-time
  // ticket (§7.1) for cookies over a same-origin request (FAPI is cross-origin
  // to the app and cannot set the cookie on the completion response itself),
  // THEN re-boot so the rest of the app sees a signed-in user. Shared by the
  // password/flow `submit` and the native (Google) button, so both complete a
  // sign-in identically.
  const finish = useCallback(
    async (next: FlowState) => {
      setState(next);
      if (next.attempt?.status === 'complete') {
        if (next.ticket) {
          await client.post('/v1/client/tickets/exchange', {
            attempt_id: (next.attempt as { id?: string }).id,
            ticket: next.ticket,
          });
        }
        await reload();
        // §R3.2 wake sibling tabs now, rather than when they next gain focus.
        broadcastSessionChange();
        // §10.2 send the user on once signed-in — no-op when afterUrl is unset.
        navigateAfterComplete(afterUrl);
      }
    },
    [afterUrl, broadcastSessionChange, client, reload],
  );

  const submit = useCallback(
    (values: Record<string, string>) => {
      void (async () => {
        setState((current) => ({ ...current, busy: true, errors: [] }));

        const kind = state.attempt ? nextStep(state.attempt).kind : 'collect_identifier';
        let input = values;
        let sentToken = false;
        if (kind === 'collect_identifier' || kind === 'collect_captcha') {
          if (values.identifier) identifierRef.current = values.identifier;
          if (captcha.needed) {
            const token = await captcha.getToken();
            if (token) {
              // The challenge marker carries no attempt; re-issue the identifier
              // POST with the token to create the real attempt.
              const identifier =
                identifierRef.current ||
                ((state.attempt as { identifier?: string | null } | null)?.identifier ?? '');
              input = { ...values, identifier, captcha_token: token };
              sentToken = true;
            } else if (kind === 'collect_captcha') {
              // Nothing to send until the widget yields a token.
              setState((current) => ({
                ...current,
                busy: false,
                errors: [{ code: 'CAPTCHA_REQUIRED', message: t('captcha.required') }],
              }));
              return;
            }
          }
        }

        let next = await advance(client, state, input);

        // A token the provider rejected comes back as the same challenge (the
        // server does not say why); say so, and draw a fresh widget — tokens are
        // single-use.
        const rechallenged = !!next.attempt && nextStep(next.attempt).kind === 'collect_captcha';
        if (sentToken && rechallenged) {
          next = { ...next, errors: [{ code: 'CAPTCHA_FAILED', message: t('captcha.failed') }] };
        }
        const localized = localizeCaptchaErrors(next.errors, t);
        next = { ...next, errors: localized.errors };
        if (sentToken && (rechallenged || next.errors.length > 0)) captcha.reset();

        await finish(next);
      })();
    },
    [captcha, client, finish, state, t],
  );
  submitRef.current = submit;

  /** §5.3: collect a sign-in completed by a link opened on another device. */
  useEffect(() => {
    if (!shouldKeepPolling(state)) return;

    const timer = setInterval(() => {
      void (async () => {
        const { state: next, ticket } = await pollAttempt(client, state);
        setState(next);
        if (!ticket || !next.attempt) return;

        // The ticket is exchanged by a normal request, so no session token has
        // ever appeared in a URL.
        await client.post('/v1/client/tickets/exchange', {
          attempt_id: (next.attempt as { id?: string }).id,
          ticket,
        });
        await reload();
        // §10.2 a cross-device sign-in that completes here redirects too.
        navigateAfterComplete(afterUrl);
      })();
    }, 2_000);

    return () => clearInterval(timer);
  }, [afterUrl, client, reload, state]);

  return { state, setState, submit, client, finish, captcha };
}

/** Google's multi-color "G" mark — trusted, static, first-party SVG. */
function GoogleMark() {
  return (
    <svg
      className="atlas-social-icon"
      width="18"
      height="18"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.84z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"
      />
    </svg>
  );
}

/**
 * A social provider as it appears in `/v1/client/environment`.
 *
 * §2.1a `mode` is the per-provider render mode the server resolves: `"redirect"`
 * forces the ordinary redirect OAuth button and suppresses the in-page GSI
 * library for that provider (its origin isn't a registered "Authorized
 * JavaScript origin", so native GSI would 403 the button iframe and do nothing,
 * while the redirect flow works with only the already-registered redirect URI);
 * `"native"` — or absent, the current default — keeps today's native behaviour.
 */
export interface EnvSocialProvider {
  provider: string;
  native?: boolean;
  allow_sign_in?: boolean;
  client_id?: string;
  label?: string | null;
  icon?: { type: 'svg' | 'url'; value: string } | null;
  mode?: 'native' | 'redirect';
}

/**
 * §2.1a whether a provider should light up the in-page native Google (GSI) flow:
 * Google, configured native with a public client_id, allowed for sign-in, and NOT
 * pinned to redirect mode. When the server resolves `mode:"redirect"`, this is
 * false, so the button renders as an ordinary redirect button and the GSI library
 * is never loaded for it.
 */
export function usesNativeGoogle(p: EnvSocialProvider): boolean {
  return (
    p.provider === 'google' &&
    p.native === true &&
    !!p.client_id &&
    p.allow_sign_in !== false &&
    p.mode !== 'redirect'
  );
}

/**
 * §2.1b did GSI actually draw its button? An origin not registered in the Google
 * client 403s the button iframe WITHOUT throwing, so initialize()/renderButton()
 * both resolve but no real button is ever drawn. A genuinely rendered button has
 * a GSI iframe of non-trivial height; anything less is a silent failure to fall
 * back from.
 */
export function gsiButtonRendered(
  frame: { getBoundingClientRect(): { height: number } } | null | undefined,
): boolean {
  return !!frame && frame.getBoundingClientRect().height >= 8;
}

/**
 * customer spec 4.5 — how a native Google provider's button is rendered. This is
 * the spec's `appearance:"host"|"google"`, named `googleButton` here so it never
 * collides with the `appearance` THEMING prop on `<AtlasProvider>`.
 *
 * - `'host'` (the default, = today's behaviour): the app's OWN styled button, with
 *   Google's real GSI button overlaid INVISIBLY on top (the overlay technique).
 * - `'google'`: Google's OWN GSI button rendered VISIBLY, instead of the styled
 *   host button — Google controls that button's look. For teams who'd rather not
 *   maintain a styled button at all.
 */
export type GoogleButtonMode = 'host' | 'google';

/**
 * §4.5 the render-mode decision, pulled out as a PURE function so it is unit-testable
 * without a DOM (this package's tests are pure-function; there is no DOM render
 * harness). It answers the two questions {@link GoogleSignInButton} asks:
 *
 * - `visible`: should Google's GSI button be drawn visibly (its own look), or as the
 *   transparent overlay on the host button? Depends on `googleButton` ALONE, so it can
 *   be computed before the overlay hook runs. True only in `'google'` mode.
 * - `showHostChrome`: should the app's styled button chrome (the Google mark + label)
 *   be drawn? Always in `'host'` mode. In `'google'` mode only when GSI is NOT the live
 *   click path (`active` false) — i.e. GSI was blocked or never rendered — so the
 *   button degrades to a visible, clickable REDIRECT fallback instead of a blank,
 *   unclickable surface. A dead/blocked GSI therefore still falls back to redirect in
 *   BOTH modes. `active` defaults to true (GSI live) when a caller only needs `visible`.
 */
export function resolveGoogleButtonRender(input: {
  googleButton?: GoogleButtonMode;
  active?: boolean;
}): { mode: GoogleButtonMode; visible: boolean; showHostChrome: boolean } {
  const mode: GoogleButtonMode = input.googleButton === 'google' ? 'google' : 'host';
  const active = input.active ?? true;
  return {
    mode,
    visible: mode === 'google',
    showHostChrome: mode === 'host' || !active,
  };
}

/** §2.1b grace period before the watchdog decides GSI never rendered a button. */
const GSI_RENDER_GRACE_MS = 2_500;

/**
 * Why a native (in-page) provider is unavailable, reported to `onProviderUnavailable`.
 * `'script_blocked'`: the provider's library threw or was blocked from loading (an
 * extension or privacy list). `'not_rendered'`: it loaded but drew no usable button
 * within the grace period (an unregistered JavaScript origin, or a blocked iframe).
 * In both cases the button has already fallen back to the redirect flow.
 */
export type ProviderUnavailableReason = 'script_blocked' | 'not_rendered';

/**
 * §6 shared native-Google wiring, reused by the built-in {@link GoogleSignInButton}
 * AND the headless `<SocialSignInButton provider="google">` primitive — so a team
 * that renders its OWN Google button gets the same in-page GSI flow, never a
 * redirect that strands the tab.
 *
 * It discovers — dynamically, from `/v1/client/environment`, so it always honours
 * the tenant's own Connections config — whether the instance exposes Google as a
 * native (id_token / GSI) provider with a public client_id. When it does, it mints
 * a single-use replay-binding nonce and overlays Google's real (but transparent)
 * button onto `ref`'s node, so a click there mints an id_token in-page. Each
 * resulting credential is handed to `onCredential(idToken, nonce)` — the caller
 * decides how to complete the sign-in (post to the native endpoint, exchange the
 * ticket, react to a second factor). `active` reports whether the overlay is
 * currently the live click path, so a caller can suppress its own redirect handler
 * while Google is handled in page and fall back to redirect/popup when it is not.
 * `configured` reports whether native Google was discovered at all (a client_id in
 * `native` mode) regardless of whether the GSI attempt later failed — a caller
 * that renders its own Google button uses it to decide whether to render one.
 *
 * §2.1a/§2.1b native is never a dead end. The overlay only counts as `active` once
 * GSI has actually drawn its button; if the GSI library can't initialize — script
 * blocked/unavailable (throws), or the page's origin isn't a registered Authorized
 * JavaScript origin, which 403s the button iframe silently — the overlay is torn
 * down, `active` flips to false, and the caller's redirect handler takes over. And
 * `mode:"redirect"` from the environment (§2.1a) is honoured up front: `configured`
 * is false, so the GSI library is never loaded for that provider.
 *
 * `enabled` (default true) lets a caller opt out entirely, e.g. for a non-Google
 * provider — the discovery fetch and overlay are then skipped.
 */
export function useGoogleNativeOverlay(
  ref: { current: HTMLElement | null },
  opts: {
    client: FapiClient;
    onCredential: (idToken: string, nonce: string) => void | Promise<void>;
    oneTap?: boolean;
    enabled?: boolean;
    /**
     * §4.5 render Google's GSI button VISIBLY (its own look) rather than as the
     * invisible overlay on the host button. Threaded straight to
     * {@link renderGoogleOverlayButton}'s `visible`. Default false (overlay).
     */
    visible?: boolean;
    /**
     * §2.1b/ask#3 fired once when native Google was configured but its in-page
     * library could not be used, so the button has fallen back to redirect. Lets a
     * caller render its own honest copy instead of inspecting our DOM.
     */
    onUnavailable?: (reason: ProviderUnavailableReason) => void;
  },
): { active: boolean; configured: boolean } {
  const { client, onCredential, oneTap, enabled = true, visible = false } = opts;
  const [clientId, setClientId] = useState<string | null>(null);
  // Kept in a ref so passing an inline `onUnavailable` doesn't re-run the overlay
  // effect (which would re-init GSI) on every render.
  const onUnavailableRef = useRef(opts.onUnavailable);
  onUnavailableRef.current = opts.onUnavailable;
  // §2.1b set once the GSI attempt is known to have failed (it threw, or the
  // watchdog found no rendered button). When it flips, `active` goes false and the
  // caller's redirect handler becomes the live click path — the native button
  // degrades to the ordinary redirect OAuth flow instead of doing nothing.
  const [failed, setFailed] = useState(false);

  // Discover the Google client_id — exposed only for a provider the instance
  // resolved to NATIVE mode with a public client_id (see {@link usesNativeGoogle}).
  // A `mode:"redirect"` Google is skipped here, so the GSI library never loads for
  // it and it renders as an ordinary redirect button instead.
  useEffect(() => {
    if (!enabled) {
      setClientId(null);
      return;
    }
    let alive = true;
    void (async () => {
      const res = await client.get<{ social_providers?: EnvSocialProvider[] }>(
        '/v1/client/environment',
      );
      const google = res.data?.social_providers?.find(usesNativeGoogle);
      if (alive) setClientId(google?.client_id ?? null);
    })();
    return () => {
      alive = false;
    };
  }, [client, enabled]);

  // Overlay Google's invisible button on the caller's node once client_id is known.
  useEffect(() => {
    const wrapper = ref.current;
    if (!enabled || !clientId || !wrapper) return;
    // Fresh attempt for a newly discovered client_id: clear any prior failure.
    setFailed(false);
    let cancelled = false;
    let notified = false;
    let handle: { destroy: () => void } | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    // Tear the (transparent, click-swallowing) overlay down and fall back, and tell
    // the caller ONCE why native Google is unavailable (so it can render honest copy
    // instead of poking at our DOM). `reason`: 'script_blocked' = the GSI script/init
    // threw or was blocked (extension / privacy list); 'not_rendered' = init resolved
    // but no button iframe appeared (origin not allowed, or the iframe was blocked).
    const fail = (reason: ProviderUnavailableReason) => {
      if (cancelled) return;
      handle?.destroy();
      handle = undefined;
      setFailed(true);
      if (!notified) {
        notified = true;
        // Tell the customer's page (its own honest-copy hook)...
        onUnavailableRef.current?.(reason);
        // ...and tell Atlas, once, for the dashboard provider-health signal.
        // Best-effort: never throws, swallows all errors, no-op under SSR.
        reportProviderUnavailable(client, 'google', reason);
      }
    };
    void (async () => {
      const nonce = await mintNativeNonce(client, 'google');
      if (cancelled || !nonce || !ref.current) return;
      // §2.1b GSI can throw synchronously (script blocked/unavailable, renderButton
      // rejected). Catch it and fall back rather than leaving a dead button and an
      // unhandled rejection on every render.
      try {
        handle = await renderGoogleOverlayButton({
          wrapper,
          clientId,
          nonce,
          oneTap: oneTap ?? false,
          visible,
          onCredential: (idToken) => {
            void onCredential(idToken, nonce);
          },
        });
      } catch {
        fail('script_blocked');
        return;
      }
      if (cancelled) {
        handle.destroy();
        return;
      }
      // §2.1b the silent failure: an unregistered origin 403s the button iframe, so
      // initialize()/renderButton() both resolve but no real button is drawn. After
      // a short grace period, if no GSI iframe of non-trivial height exists under
      // our node, tear the overlay down and fall back to redirect.
      watchdog = setTimeout(() => {
        if (cancelled) return;
        if (!gsiButtonRendered(ref.current?.querySelector('iframe'))) fail('not_rendered');
      }, GSI_RENDER_GRACE_MS);
    })();
    return () => {
      cancelled = true;
      if (watchdog) clearTimeout(watchdog);
      handle?.destroy();
    };
  }, [ref, client, clientId, oneTap, enabled, visible, onCredential]);

  const configured = enabled && clientId != null;
  return { active: configured && !failed, configured };
}

/**
 * §6 the native "Sign in with Google" button (GSI id_token flow — no secret, no
 * redirect). Discovers whether Google native sign-in is enabled for the instance
 * via `/v1/client/environment`; if so it mints a single-use replay-binding nonce
 * and renders OUR OWN themed button, backed by Google's real (but transparent)
 * GSI button overlaid on top. The user sees a button that inherits the app's
 * appearance (the `socialButton` element key / `atlas-social-button` class, so
 * `appearance.elements.socialButton` and the design tokens theme it like every
 * other control) — NOT Google's fixed, unstyleable button. On a returned
 * credential the id_token is posted to the native endpoint and completes through
 * the shared `finish`. Renders nothing when Google isn't a native provider for the
 * instance (a `mode:"redirect"` Google renders in the redirect list instead).
 *
 * §2.1b when native Google IS configured but GSI can't initialize (origin not
 * registered / script blocked), the overlay is torn down and this same styled
 * button falls back to the redirect OAuth flow via `onRedirect` — it is never a
 * dead button. That mirrors the hosted page's fallback.
 *
 * §4.5 `googleButton` chooses what the user SEES when GSI works:
 *   - `'host'` (default): the styled host button above, with Google's real button
 *     overlaid invisibly — today's behaviour, unchanged.
 *   - `'google'`: Google's OWN button, rendered visibly in place of the host
 *     chrome (Google controls its look). The host chrome is drawn only if GSI
 *     fails, so the redirect fallback is still a visible, clickable button.
 * The fallback + `onUnavailable` behaviour is identical in both modes.
 *
 * One-Tap stays off unless `oneTap` is set (see {@link FlowProps.googleOneTap}).
 */
function GoogleSignInButton({
  client,
  onComplete,
  oneTap,
  onRedirect,
  onUnavailable,
  googleButton,
}: {
  client: FapiClient;
  onComplete: (next: FlowState) => void | Promise<void>;
  oneTap?: boolean;
  /** Start the ordinary redirect OAuth flow for Google (the §2.1b fallback). */
  onRedirect: () => void;
  /** Fired once when native Google fell back to redirect (see {@link ProviderUnavailableReason}). */
  onUnavailable?: (reason: ProviderUnavailableReason) => void;
  /** §4.5 render mode: `'host'` (styled button + invisible overlay, default) or
   * `'google'` (Google's own visible button). See {@link resolveGoogleButtonRender}. */
  googleButton?: GoogleButtonMode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const socialButtonClass = useClass('socialButton', 'atlas-social-button');
  const cls = useClasses();
  const onCredential = useCallback(
    async (idToken: string, nonce: string) => {
      const next = await nativeSignIn(client, { provider: 'google', idToken, nonce });
      await onComplete(next);
    },
    [client, onComplete],
  );
  // `visible` depends on the mode alone, so it is settled before the overlay hook
  // runs and can be threaded straight in.
  const { visible } = resolveGoogleButtonRender({ googleButton });
  const { active, configured } = useGoogleNativeOverlay(ref, {
    client,
    onCredential,
    oneTap,
    visible,
    onUnavailable,
  });

  // Google isn't a native provider here (or it's mode:"redirect"): the redirect
  // Google button is rendered by SocialSignInButtons' provider list instead.
  if (!configured) return null;
  // When the overlay is live it catches the click (native id_token in-page, no
  // redirect); once GSI has failed and the overlay is torn down, `active` is false
  // and this handler is the live path — the native button falls back to redirect.
  const fallback = () => {
    if (!active) onRedirect();
  };
  // `showHostChrome`: in 'host' mode always (GSI overlays it invisibly). In 'google'
  // mode only once GSI has FAILED — then the host chrome is the visible redirect
  // fallback; while GSI is live, Google's own visible button covers the node and the
  // host chrome is omitted so Google's look wins.
  const { showHostChrome } = resolveGoogleButtonRender({ googleButton, active });
  // Our styled button; GSI's real button is overlaid onto this node (invisibly in
  // 'host' mode, visibly in 'google' mode). Defaults are driven by the appearance
  // design tokens (`--atlas-*` set on `.atlas-root`), so the button matches the app's
  // theme out of the box AND updates when a customer sets `appearance.variables`;
  // `appearance.elements.socialButton` (appended to the class) still layers CSS on top.
  // In 'google' mode while GSI is live we drop the host border/background (its own
  // button draws the surface) but keep the sizing box so the overlay has one to fill.
  const style = showHostChrome ? DEFAULT_SOCIAL_BUTTON_STYLE : GOOGLE_MODE_CONTAINER_STYLE;
  return (
    <div
      ref={ref}
      className={socialButtonClass}
      data-atlas="google-signin"
      data-atlas-provider="google"
      data-atlas-google-button={googleButton === 'google' ? 'google' : 'host'}
      role="button"
      tabIndex={0}
      style={style}
      onClick={fallback}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') fallback();
      }}
    >
      {showHostChrome ? (
        <>
          <GoogleMark />
          <span className={cls('socialButtonText', 'atlas-social-label')}>Continue with Google</span>
        </>
      ) : null}
    </div>
  );
}

/** Theme-token defaults so the social button looks right with no customer CSS. */
const DEFAULT_SOCIAL_BUTTON_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '8px',
  width: '100%',
  boxSizing: 'border-box',
  // Each value reads the design variable first (defined only when a design is
  // active) and falls back to the legacy token, so with no design the button is
  // exactly as before.
  minHeight: 'var(--atlas-control-height, 40px)',
  padding: '10px 16px',
  border: 'var(--atlas-border-width, 1px) solid var(--atlas-color-border, #e4e4e9)',
  borderRadius: 'var(--atlas-radius-control, var(--atlas-border-radius, 8px))',
  background: 'var(--atlas-color-surface, var(--atlas-color-background, #ffffff))',
  color: 'var(--atlas-color-text, #1c1c1f)',
  fontFamily: 'var(--atlas-font-family, var(--atlas-font-body, inherit))',
  fontWeight: 500,
  cursor: 'pointer',
  userSelect: 'none',
};

/**
 * §4.5 `googleButton:"google"` container: Google draws its OWN button surface, so we
 * keep only the sizing box (so the visible overlay has a width to stretch to and a
 * height to center in) and drop the host border/background/padding. The overlay's
 * ResizeObserver tracks `width:100%`.
 */
const GOOGLE_MODE_CONTAINER_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '100%',
  boxSizing: 'border-box',
  minHeight: '40px',
  cursor: 'pointer',
};

/** Human label for a provider key, for the redirect button text. */
const PROVIDER_LABEL: Record<string, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  microsoft: 'Microsoft',
  apple: 'Apple',
  facebook: 'Facebook',
  discord: 'Discord',
  linkedin: 'LinkedIn',
  google: 'Google',
  x: 'X',
  twitter: 'X',
  slack: 'Slack',
  spotify: 'Spotify',
  twitch: 'Twitch',
  notion: 'Notion',
};
function providerLabel(p: string): string {
  return PROVIDER_LABEL[p] ?? p.charAt(0).toUpperCase() + p.slice(1).replace(/[_-]/g, ' ');
}

/** The SSO connection id for "Sign in with Atlas" when the instance has it enabled, else null. */
export function atlasSsoTarget(appearance: {
  sign_in_with_atlas?: { enabled: boolean; connection_id?: string };
}): string | null {
  const s = appearance.sign_in_with_atlas;
  return s?.enabled && s.connection_id ? s.connection_id : null;
}

export function AtlasSsoButton({
  onClick,
  className,
  labelClassName,
}: {
  onClick: () => void;
  className?: string;
  /** Class for the label (defaults to `atlas-social-label`). */
  labelClassName?: string;
}) {
  return (
    <div
      className={className}
      data-atlas="social-signin"
      data-atlas-provider="atlas"
      role="button"
      tabIndex={0}
      style={DEFAULT_SOCIAL_BUTTON_STYLE}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          // Space would also scroll the page; a real <button> doesn't.
          e.preventDefault();
          onClick();
        }
      }}
    >
      <span className={labelClassName ?? 'atlas-social-label'}>Continue with Atlas</span>
    </div>
  );
}

/**
 * §6 all enabled social sign-in providers, native-first.
 *
 * A provider with an in-page native flow (Google today) renders its secretless
 * button — no redirect, no new tab, no stranded initiating tab. Every OTHER
 * enabled provider (GitHub, Microsoft, Discord, …) renders a redirect button that
 * starts the OAuth flow and returns to THIS page, where `<AtlasProvider>` exchanges
 * the returned ticket for a session. Previously `<SignIn>` rendered only the
 * Google button, so an instance's other social providers never appeared.
 */
export function SocialSignInButtons({
  client,
  onComplete,
  oneTap,
  oauthMode,
  onProviderUnavailable,
  googleButton,
}: {
  client: FapiClient;
  onComplete: (next: FlowState) => void | Promise<void>;
  oneTap?: boolean;
  oauthMode?: 'popup' | 'redirect';
  onProviderUnavailable?: (provider: string, reason: ProviderUnavailableReason) => void;
  /** §4.5 native Google button render mode (see {@link FlowProps.googleButton}). */
  googleButton?: GoogleButtonMode;
}) {
  const socialButtonClass = useClass('socialButton', 'atlas-social-button');
  const cls = useClasses();
  const { oauthMode: providerOauthMode } = useAtlas();
  const errorText = useErrorText();
  const effectiveMode = oauthMode ?? providerOauthMode ?? 'redirect';
  const [redirectProviders, setRedirectProviders] = useState<
    Array<{
      provider: string;
      label?: string | null;
      icon?: { type: 'svg' | 'url'; value: string } | null;
    }>
  >([]);
  const [atlasConnection, setAtlasConnection] = useState<string | null>(null);
  const [atlasError, setAtlasError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const appearance = await client.get<{
          sign_in_with_atlas?: { enabled: boolean; connection_id?: string };
        }>('/v1/appearance');
        if (alive && appearance.data) setAtlasConnection(atlasSsoTarget(appearance.data));
      } catch {
        // No Atlas button is the safe fallback when appearance can't be read.
      }
    })();
    return () => {
      alive = false;
    };
  }, [client]);

  const startAtlas = useCallback(() => {
    void (async () => {
      if (typeof window === 'undefined' || !atlasConnection) return;
      setAtlasError(null);
      try {
        const res = await client.post<{ authorization_url?: string }>('/v1/client/sign_ins/sso', {
          connection_id: atlasConnection,
          redirect_url: window.location.href,
        });
        const url = res.data?.authorization_url;
        if (url) window.location.assign(url);
        else setAtlasError(res.errors?.[0] ? errorText(res.errors[0]) : 'Could not start Sign in with Atlas.');
      } catch {
        setAtlasError('Could not start Sign in with Atlas.');
      }
    })();
  }, [client, atlasConnection, errorText]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const res = await client.get<{ social_providers?: EnvSocialProvider[] }>(
        '/v1/client/environment',
      );
      const list = (res.data?.social_providers ?? [])
        .filter((p) => p.allow_sign_in !== false)
        // Google renders as the native GSI button below — UNLESS the instance
        // resolved it to redirect mode (§2.1a), in which case it needs an ordinary
        // redirect button here (GoogleSignInButton renders nothing for a non-native
        // Google). Any other native provider gets its own in-page button in a later
        // pass; the rest use redirect.
        .filter((p) => p.provider !== 'google' || p.mode === 'redirect')
        // Carry the per-instance branding label override (e.g. "Continue with
        // Discord") and the resolved icon (built-in brand SVG or a tenant
        // override URL) through to the button — so github (native) and a custom
        // provider both render their mark, not label-only.
        .map((p) => ({ provider: p.provider, label: p.label, icon: p.icon }));
      if (alive) setRedirectProviders(list);
    })();
    return () => {
      alive = false;
    };
  }, [client]);

  const startSocial = useCallback(
    (provider: string) => {
      void (async () => {
        if (typeof window === 'undefined') return;
        const redirectUrl = window.location.href;

        if (effectiveMode === 'popup') {
          const out = await startOauthPopup(client, { provider, redirectUrl });
          // Popup blocked → fall back to a full redirect (always safe to enable).
          if (out.blocked && out.authorizationUrl) {
            window.location.href = out.authorizationUrl;
            return;
          }
          // Completed in the popup → drive the SAME completion path as the native
          // (Google) button: exchange the one-time ticket + re-boot signed-in.
          if (out.ticket) {
            await onComplete({
              attempt: { id: out.attemptId, status: 'complete' },
              ticket: out.ticket,
            } as unknown as FlowState);
            return;
          }
          // 2FA / connect / provider error → hand off to the redirect continuation
          // so the existing status handling takes over in the opener.
          if (out.continuationUrl) {
            window.location.href = out.continuationUrl;
            return;
          }
          // Closed without posting back, but the session now exists: the popup
          // finished the sign-in itself (the browser severed window.opener). Drive
          // the same completion path, minus the ticket the cookies already used.
          if (out.sessionDetected) {
            await onComplete({ attempt: { status: 'complete' } } as unknown as FlowState);
            return;
          }
          // popup_closed / start_failed → the user cancelled; nothing to do.
          return;
        }

        const res = await startOauthRedirect(client, { provider, redirectUrl });
        if (res) window.location.href = res.authorizationUrl;
      })();
    },
    [client, effectiveMode, onComplete],
  );

  return (
    <>
      <GoogleSignInButton
        client={client}
        onComplete={onComplete}
        oneTap={oneTap}
        googleButton={googleButton}
        onRedirect={() => startSocial('google')}
        onUnavailable={
          onProviderUnavailable ? (reason) => onProviderUnavailable('google', reason) : undefined
        }
      />
      {redirectProviders.map(({ provider, label, icon }) => (
        <div
          key={provider}
          className={socialButtonClass}
          data-atlas="social-signin"
          data-atlas-provider={provider}
          role="button"
          tabIndex={0}
          style={DEFAULT_SOCIAL_BUTTON_STYLE}
          onClick={() => startSocial(provider)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') startSocial(provider);
          }}
        >
          {/* Icon from the environment: a first-party brand SVG (safe to inline)
              or a resolved override URL (<img>). Fixes github (native, was
              icon-less in the SDK) and custom providers with an override. */}
          {icon?.type === 'svg' ? (
            <span
              className={cls('socialButtonIcon', 'atlas-social-icon')}
              aria-hidden
              dangerouslySetInnerHTML={{ __html: icon.value }}
            />
          ) : icon?.type === 'url' ? (
            <span className={cls('socialButtonIcon', 'atlas-social-icon')}>
              <img src={icon.value} width={18} height={18} alt="" loading="lazy" />
            </span>
          ) : null}
          <span className={cls('socialButtonText', 'atlas-social-label')}>
            {label ?? `Continue with ${providerLabel(provider)}`}
          </span>
        </div>
      ))}
{atlasConnection ? (
        <AtlasSsoButton
          className={socialButtonClass}
          labelClassName={cls('socialButtonText', 'atlas-social-label')}
          onClick={startAtlas}
        />
      ) : null}
      {atlasError ? (
        <div className={cls('alert', 'atlas-alert')} role="alert" data-atlas="social-signin-error">
          {atlasError}
        </div>
      ) : null}
    </>
  );
}
