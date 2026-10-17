/**
 * §5.3 which first factor a sign-in form shows, and when it emails one on its own.
 *
 * Shared by every prebuilt UI so they agree on one rule: a password field is drawn
 * only when the server offers `password`. When it doesn't and an emailed factor is
 * on offer, the form sends that factor straight away (a code before a link) and
 * shows the "check your email" step, because asking for a password the app does
 * not accept leaves the user with no way in. When both are on offer, password is
 * the default and the emailed factors are links under it.
 */

export type EmailFactor = 'email_code' | 'email_link';

export interface FirstFactorPlan {
  /** Draw the password field. */
  password: boolean;
  /** The emailed factors on offer, code first. */
  email: EmailFactor[];
  /** The emailed factor to send without asking, when password isn't offered. */
  autoSend: EmailFactor | null;
}

/**
 * Plan the first-factor step from the factors the form may offer (the server's
 * list after `offeredFirstFactors`). Pure, so every framework tests the same rule.
 */
export function planFirstFactor(offered: readonly string[]): FirstFactorPlan {
  const email = (['email_code', 'email_link'] as const).filter((s) => offered.includes(s));
  const password = offered.includes('password');
  return { password, email, autoSend: password ? null : (email[0] ?? null) };
}

/**
 * Seconds the server asked us to wait before another send (`retry_after` on a
 * 429), or null. Lets a "Resend" button count down instead of failing again.
 */
export function retryAfterSeconds(errors: readonly { meta?: Record<string, unknown> }[]): number | null {
  for (const error of errors) {
    const value = error.meta?.retry_after;
    if (typeof value === 'number' && value > 0) return Math.ceil(value);
  }
  return null;
}
