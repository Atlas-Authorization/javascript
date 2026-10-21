import { describe, expect, it } from 'vitest';
import { forceCaptchaFlow } from './referral';

describe('forceCaptchaFlow (referred sign-up challenge)', () => {
  const ts = { enabled: false, provider: 'turnstile', siteKey: 'k', widget: 'managed' as const };

  it('switches a drawable flow on when forced', () => {
    expect(forceCaptchaFlow(ts, true)).toEqual({ ...ts, enabled: true });
  });

  it('leaves it as is when not forced, already on, or with no provider', () => {
    expect(forceCaptchaFlow(ts, false)).toBe(ts);
    const on = { ...ts, enabled: true };
    expect(forceCaptchaFlow(on, true)).toBe(on);
    expect(forceCaptchaFlow({ enabled: false }, true)).toEqual({ enabled: false });
    expect(forceCaptchaFlow(undefined, true)).toBeUndefined();
  });
});
