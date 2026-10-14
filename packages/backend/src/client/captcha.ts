import { type RequestFn } from './request';

/**
 * The verdict `POST /v1/captcha/verify` returns. `success` is the gate decision;
 * `score` (0..1, higher = more human), `verdict` and `meta` are the provider's
 * own judgment, surfaced for the caller's risk pipeline.
 */
export interface CaptchaVerification {
  object: 'captcha_verification';
  success: boolean;
  /** The action this verification resolved for, or null for the base provider. */
  action: string | null;
  /** The provider the token was verified against. */
  provider: string;
  /** Normalized 0..1 (higher = more human); absent for pass/fail-only providers. */
  score?: number;
  /** Coarse label; `edge` for edge-enforced providers (AWS WAF, PerimeterX, …). */
  verdict?: 'pass' | 'fail' | 'low_score' | 'edge';
  /** The provider-issued challenge timestamp, when it returns one. */
  challenge_ts?: string;
  /** Provider-specific reason codes / breakdown (server-side only). */
  meta?: Record<string, unknown>;
}

/** Options for a verify call. */
export interface VerifyCaptchaOptions {
  /**
   * The customer-named action to resolve the provider for (e.g. "comment.create").
   * Omit to use the instance's base provider.
   */
  action?: string;
  /** The end-user's IP, forwarded to the provider when it accepts one (advised). */
  remoteIp?: string;
}

/**
 * "CAPTCHA anywhere" — verify a token server-side against the instance's
 * centrally-configured provider. Atlas holds the provider secret and does the
 * verification, so a tenant protects any action without holding the secret or
 * writing its own verification code. Fails CLOSED: an unconfigured provider,
 * missing secret, outage or bad token all come back `success: false`.
 */
export function captchaResource(request: RequestFn) {
  return {
    /** Verify a CAPTCHA token for an optional action. */
    verify(token: string, options: VerifyCaptchaOptions = {}): Promise<CaptchaVerification> {
      return request({
        method: 'POST',
        path: '/v1/captcha/verify',
        body: {
          token,
          ...(options.action ? { action: options.action } : {}),
          ...(options.remoteIp ? { remote_ip: options.remoteIp } : {}),
        },
      });
    },
  };
}
