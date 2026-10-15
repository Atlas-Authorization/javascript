import { useCallback, useMemo, useRef, type ReactNode, type ButtonHTMLAttributes } from 'react';
import {
  mintNativeNonce,
  nativeSignIn,
  startOauthPopup,
  startOauthRedirect,
  type OAuthPopupHandlers,
} from '@atlasauth/js';
import { useAtlas } from './AtlasProvider';
import { FapiClient, type FlowState } from './fapi';
import { CaptchaSlot } from './captcha';
import {
  AttemptFlow,
  SocialSignInButtons,
  resolveGoogleButtonRender,
  useFlow,
  useGoogleNativeOverlay,
  type FlowProps,
  type GoogleButtonMode,
  type ProviderUnavailableReason,
} from './flow';

export function SignIn(props: FlowProps = {}) {
  const { state, submit, client, finish, captcha } = useFlow({ afterUrl: props.afterUrl });

  return (
    <>
      <AttemptFlow
        attempt={state.attempt}
        busy={state.busy}
        errors={state.errors}
        titleKey="signIn.title"
        hideTitle={props.hideTitle}
        onSubmit={submit}
        captcha={<CaptchaSlot controller={captcha} />}
      />
      {/* Social buttons belong on the first step, not mid-flow (e.g. during a
          second factor). `!state.attempt` is exactly the initial identifier step. */}
      {!state.attempt ? (
        <SocialSignInButtons
          client={client}
          onComplete={finish}
          oneTap={props.googleOneTap}
          oauthMode={props.oauthMode}
          onProviderUnavailable={props.onProviderUnavailable}
          googleButton={props.googleButton}
        />
      ) : null}
    </>
  );
}

/**
 * §6 headless native sign-in, for a consumer that renders its OWN Google button
 * (or Apple / Facebook Limited Login). Mint a nonce with `mintNonce(provider)`,
 * hand it to the provider SDK, then pass the resulting id_token to
 * `signInWithIdToken` — it posts to the native endpoint, exchanges the ticket
 * for cookies and re-boots the app on completion, returning the flow state so
 * the caller can react to `needs_second_factor` etc.
 */
export function useSignIn() {
  const { publishableKey, frontendApi, locale, reload } = useAtlas();
  const client = useMemo(
    () => new FapiClient({ publishableKey, baseUrl: frontendApi, locale }),
    [frontendApi, publishableKey, locale],
  );

  const mintNonce = useCallback(
    (provider: string) => mintNativeNonce(client, provider),
    [client],
  );

  const signInWithIdToken = useCallback(
    async (input: { provider: string; idToken: string; nonce?: string }): Promise<FlowState> => {
      const next = await nativeSignIn(client, input);
      if (next.attempt?.status === 'complete' && next.ticket) {
        await client.post('/v1/client/tickets/exchange', {
          attempt_id: (next.attempt as { id?: string }).id,
          ticket: next.ticket,
        });
        await reload();
      }
      return next;
    },
    [client, reload],
  );

  /**
   * §oauth imperative — start a social/OIDC sign-in for your own button. In
   * `"popup"` mode it opens a GSI-style popup, exchanges the one-time ticket on
   * completion and re-boots signed-in (no navigation), falling back to a full
   * redirect if the popup is blocked. In `"redirect"` mode it navigates.
   */
  const startOauth = useCallback(
    async (input: {
      provider: string;
      mode?: 'popup' | 'redirect';
      redirectUrl?: string;
      handlers?: OAuthPopupHandlers;
      /** Popup mode: abort to stop waiting for the popup (e.g. a "Cancel" button). */
      signal?: AbortSignal;
    }): Promise<void> => {
      if (typeof window === 'undefined') return;
      const redirectUrl = input.redirectUrl ?? window.location.href;

      if (input.mode === 'popup') {
        const out = await startOauthPopup(
          client,
          { provider: input.provider, redirectUrl, signal: input.signal },
          input.handlers,
        );
        if (out.blocked && out.authorizationUrl) {
          window.location.href = out.authorizationUrl;
          return;
        }
        if (out.ticket) {
          await client.post('/v1/client/tickets/exchange', {
            attempt_id: out.attemptId,
            ticket: out.ticket,
          });
          await reload();
          return;
        }
        if (out.continuationUrl) {
          window.location.href = out.continuationUrl;
          return;
        }
        // The popup finished the sign-in itself (its link to this page was
        // severed): the cookies are set, so re-boot signed-in.
        if (out.sessionDetected) await reload();
        return;
      }

      const res = await startOauthRedirect(client, { provider: input.provider, redirectUrl });
      if (res) window.location.href = res.authorizationUrl;
    },
    [client, reload],
  );

  return { client, mintNonce, signInWithIdToken, startOauth };
}

/**
 * §10.2 `<SocialSignInButton>` — a headless social/OIDC sign-in button primitive
 * (a single provider). Lets a team keep their own login card and still get
 * Atlas's managed flow for a provider. `mode` defaults to the `<AtlasProvider oauthMode>`
 * value, else redirect. Lifecycle callbacks (`onOpen`/`onError`/`onBlockedFallback`)
 * fire only in popup mode.
 *
 * §6 GOOGLE is handled in-page: when the instance has Google enabled as a native
 * (GSI id_token) provider, this button keeps YOUR styling but overlays Google's
 * invisible real button on it, so a click mints an id_token in-page — no redirect,
 * no "close this tab" page, no stranded tab. That is the exact behaviour teams
 * were hand-rolling as a workaround; they can now drop it and just use this
 * primitive. It is fully dynamic: the native path lights up only when the tenant
 * has configured native Google, and otherwise (or for any other provider) the
 * button falls back to the managed popup/redirect flow. `disabled` (a native
 * button prop) is honoured either way.
 *
 * §4.5 `googleButton` (Google only) chooses the rendered button: `'host'` (default)
 * keeps YOUR button with Google's invisible button overlaid; `'google'` renders
 * Google's OWN button visibly on top of yours — yours then only shows as the
 * redirect fallback if GSI is blocked. See {@link FlowProps.googleButton}.
 */
export function SocialSignInButton({
  provider,
  mode,
  children,
  onOpen,
  onError,
  onBlockedFallback,
  onUnavailable,
  googleButton,
  ...buttonProps
}: {
  provider: string;
  mode?: 'popup' | 'redirect';
  children?: ReactNode;
  onOpen?: () => void;
  onError?: (code: string) => void;
  onBlockedFallback?: (authorizationUrl: string) => void;
  /** Native Google only: fired once when GSI can't be used and this button falls
   * back to the redirect flow (see {@link ProviderUnavailableReason}). */
  onUnavailable?: (reason: ProviderUnavailableReason) => void;
  /** §4.5 native Google only: `'host'` (default) overlays Google's invisible button
   * on yours; `'google'` renders Google's own visible button. See
   * {@link FlowProps.googleButton}. Ignored for non-Google providers. */
  googleButton?: GoogleButtonMode;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onError'>) {
  const { client, signInWithIdToken, startOauth } = useSignIn();
  const { oauthMode } = useAtlas();
  const effectiveMode = mode ?? oauthMode ?? 'redirect';
  const isGoogle = provider === 'google';
  // `visible` is settled by the mode alone, so it can be threaded into the overlay
  // hook up front. In 'google' mode Google's own button is drawn visibly on top of
  // YOUR button; yours remains underneath as the redirect fallback if GSI fails.
  const { visible } = resolveGoogleButtonRender({ googleButton });

  // Native Google overlay: complete a returned credential through the shared
  // native path (post id_token → exchange ticket → reload). enabled:false for
  // every other provider skips the discovery fetch and overlay entirely.
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const onCredential = useCallback(
    async (idToken: string, nonce: string) => {
      try {
        await signInWithIdToken({ provider: 'google', idToken, nonce });
      } catch {
        onError?.('native_sign_in_failed');
      }
    },
    [signInWithIdToken, onError],
  );
  const { active: googleNative } = useGoogleNativeOverlay(wrapperRef, {
    client,
    onCredential,
    enabled: isGoogle,
    visible: isGoogle && visible,
    onUnavailable,
  });

  const startRedirect = useCallback(() => {
    void startOauth({
      provider,
      mode: effectiveMode,
      handlers: { onOpen, onError, onBlockedFallback },
    });
  }, [startOauth, provider, effectiveMode, onOpen, onError, onBlockedFallback]);

  const button = (
    <button
      type="button"
      {...buttonProps}
      onClick={(e) => {
        buttonProps.onClick?.(e);
        // When the Google overlay is live it catches the click and mints the
        // id_token in-page; this fallback only fires before it is ready or when
        // native Google is not enabled for the instance.
        if (!googleNative) startRedirect();
      }}
    >
      {children ?? `Continue with ${isGoogle ? 'Google' : provider}`}
    </button>
  );

  // For Google, wrap the button in a positioned surface the invisible GSI button
  // is overlaid onto (a ResizeObserver keeps it matched to the button's box so
  // every click lands on it). inline-block shrinks the wrapper to the button so
  // YOUR sizing is untouched; a full-width button still fills it.
  if (isGoogle) {
    return (
      <span ref={wrapperRef} style={{ position: 'relative', display: 'inline-block' }}>
        {button}
      </span>
    );
  }
  return button;
}
