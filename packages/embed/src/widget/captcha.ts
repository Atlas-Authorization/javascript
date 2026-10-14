/**
 * Client-side captcha rendering for the hosted widget.
 *
 * The server tells the widget, per flow, which provider to render and in what
 * mode (see `/v1/appearance` → `captchaFlows`). The loader/renderer lives in
 * `@atlasauth/js` so the embed widget and the React components draw the same
 * widget the same way; this module keeps the widget's historical names.
 *
 * Only the providers that expose a standard browser widget are renderable here;
 * score/edge/fingerprint providers are verified server-side from a token a
 * custom integration supplies, so `isRenderable` returns false for them and the
 * caller proceeds without a token (the server still fails closed if it required
 * one).
 */
export {
  isRenderableCaptcha as isRenderable,
  flowNeedsCaptcha,
  loadCaptchaProvider as loadProvider,
  getCaptchaToken,
} from '@atlasauth/js';
