'use client';

import { useCallback, useEffect, useRef } from 'react';
import {
  isRenderableCaptcha,
  renderCaptchaWidget,
  type AtlasCaptchaLabels,
  type CaptchaWidgetHandle,
  type FlowCaptcha,
} from '@atlasauth/js';

/**
 * The captcha half of the prebuilt `<SignIn>`/`<SignUp>`.
 *
 * Driven entirely by the instance's settings (`captchaFlows` from
 * `/v1/appearance`), so switching captcha on in the dashboard makes the
 * components render it with no code change. The widget itself is the shared
 * `@atlasauth/js` renderer the embed widget also uses.
 *
 * Lifecycle: a visible/managed widget is drawn as soon as its slot mounts, so
 * the user can solve it while filling in the form; an invisible one is executed
 * only when the form is submitted. Tokens are single-use, so after a submit
 * spent one the caller `reset()`s, which draws a fresh widget.
 */
export interface CaptchaController {
  /** Whether this flow renders a widget at all. */
  needed: boolean;
  /** Callback ref for the element the widget draws into. */
  slotRef: (el: HTMLDivElement | null) => void;
  /** The solved token, rendering/executing the widget first if needed. Null when
   *  no captcha is needed, or the provider failed (the server then refuses with
   *  CAPTCHA_REQUIRED, which the caller turns into a message). */
  getToken(): Promise<string | null>;
  /** Drop the (spent) widget and, for a visible one, draw a fresh one. */
  reset(): void;
}

export function useCaptcha(
  flow: FlowCaptcha | undefined,
  options: {
    /** Render at all — the caller's "this flow requires a token here" decision. */
    active: boolean;
    /** Draw the widget as soon as the slot mounts. Default: unless invisible. */
    eager?: boolean;
    /** Called with the token when an eagerly drawn widget is solved. */
    onSolved?: (token: string) => void;
    /** The Atlas captcha's words in the form's language (`atlasCaptchaLabels(t)`). */
    atlasLabels?: Partial<AtlasCaptchaLabels>;
  },
): CaptchaController {
  const needed = options.active && !!flow && isRenderableCaptcha(flow.provider);
  const eager = options.eager ?? flow?.widget !== 'invisible';

  const container = useRef<HTMLDivElement | null>(null);
  const handle = useRef<CaptchaWidgetHandle | null>(null);
  const onSolved = useRef(options.onSolved);
  onSolved.current = options.onSolved;
  // The latest flow/needed, read by the stable callbacks below.
  const flowKey = `${needed}|${flow?.provider ?? ''}|${flow?.siteKey ?? ''}|${flow?.widget ?? ''}|${eager}`;
  const live = useRef({ flow, needed, eager, flowKey, atlasLabels: options.atlasLabels });
  live.current = { flow, needed, eager, flowKey, atlasLabels: options.atlasLabels };
  // The settings the current widget was drawn with, so a redraw happens only
  // when they actually change.
  const drawnKey = useRef<string | null>(null);

  const remove = useCallback(() => {
    handle.current?.remove();
    handle.current = null;
    drawnKey.current = null;
  }, []);

  const mount = useCallback((): CaptchaWidgetHandle | null => {
    const { flow: f, needed: n } = live.current;
    const el = container.current;
    remove();
    if (!n || !f || !el) return null;
    const h = renderCaptchaWidget(f, el, { atlas: { labels: live.current.atlasLabels } });
    handle.current = h;
    drawnKey.current = live.current.flowKey;
    // Swallow here so a removed / failed widget is never an unhandled
    // rejection; getToken() reads the same promise and reports it.
    h.token.then(
      (token) => {
        if (handle.current === h) onSolved.current?.(token);
      },
      () => undefined,
    );
    return h;
  }, [remove]);

  const slotRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (el === container.current) return;
      container.current = el;
      if (!el) {
        remove();
        return;
      }
      if (live.current.needed && live.current.eager) mount();
    },
    [mount, remove],
  );

  // A settings change (the provider/site key arrived, or the flow switched on)
  // while the slot is already mounted: redraw for the new config.
  useEffect(() => {
    if (!container.current) return;
    if (!live.current.needed || !live.current.eager) remove();
    else if (drawnKey.current !== flowKey) mount();
  }, [flowKey, mount, remove]);

  useEffect(() => remove, [remove]);

  const reset = useCallback(() => {
    remove();
    if (live.current.needed && live.current.eager) mount();
  }, [mount, remove]);

  // The handle whose token a submit already took. Tokens are single-use, so the
  // next getToken() draws a fresh widget instead of replaying it.
  const spent = useRef<CaptchaWidgetHandle | null>(null);

  const getToken = useCallback(async (): Promise<string | null> => {
    if (!live.current.needed) return null;
    let h = handle.current;
    if (!h || spent.current === h || h.stale?.()) h = mount();
    if (!h) return null;
    try {
      const token = await h.token;
      spent.current = h;
      return token;
    } catch {
      // The provider errored / timed out: start over with a fresh widget.
      if (handle.current === h) reset();
      return null;
    }
  }, [mount, reset]);

  return { needed, slotRef, getToken, reset };
}

/** The element the widget draws into. Empty until the provider renders. */
export function CaptchaSlot({ controller }: { controller: CaptchaController }) {
  if (!controller.needed) return null;
  return <div ref={controller.slotRef} className="atlas-captcha" data-atlas-captcha="" />;
}

/**
 * Swap the server's captcha refusals (CAPTCHA_REQUIRED / CAPTCHA_FAILED) for a
 * localized, form-level message. Shared with the other framework SDKs.
 */
export { localizeCaptchaErrors } from '@atlasauth/js';
