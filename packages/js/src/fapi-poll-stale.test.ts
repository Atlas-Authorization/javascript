import { describe, expect, it } from 'vitest';
import { pollAnswerStale } from './fapi';

describe('pollAnswerStale', () => {
  const attempt = { id: 'sia_1', status: 'needs_email_verification' } as never;
  const polled = { pollSecret: 's', attempt };

  it('keeps an answer when nothing moved', () => {
    expect(pollAnswerStale({ ...polled, busy: false }, polled)).toBe(false);
  });

  it("drops it once this tab has submitted, so its own request's answer stands", () => {
    expect(pollAnswerStale({ ...polled, busy: true }, polled)).toBe(true);
    expect(pollAnswerStale({ pollSecret: 's', attempt: { id: 'sia_1', status: 'complete' } as never, busy: false }, polled)).toBe(true);
  });

  it('drops it after a resend rotated the secret', () => {
    expect(pollAnswerStale({ pollSecret: 'other', attempt, busy: false }, polled)).toBe(true);
  });
});
