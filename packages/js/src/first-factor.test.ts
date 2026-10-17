import { describe, expect, it } from 'vitest';
import { planFirstFactor, retryAfterSeconds } from './first-factor';

describe('planFirstFactor', () => {
  it('sends the emailed code on its own when password is not offered', () => {
    expect(planFirstFactor(['email_code', 'passkey'])).toEqual({ password: false, email: ['email_code'], autoSend: 'email_code' });
  });
  it('prefers a code over a link', () => {
    expect(planFirstFactor(['email_link', 'email_code']).autoSend).toBe('email_code');
    expect(planFirstFactor(['email_link']).autoSend).toBe('email_link');
  });
  it('defaults to password when it is offered, emailed factors as alternatives', () => {
    expect(planFirstFactor(['password', 'email_code', 'email_link'])).toEqual({
      password: true,
      email: ['email_code', 'email_link'],
      autoSend: null,
    });
  });
  it('sends nothing when no emailed factor is offered', () => {
    expect(planFirstFactor(['passkey']).autoSend).toBeNull();
  });
});

describe('retryAfterSeconds', () => {
  it('reads retry_after from a 429', () => {
    expect(retryAfterSeconds([{ meta: { retry_after: 29.2 } }])).toBe(30);
    expect(retryAfterSeconds([{}])).toBeNull();
  });
});
