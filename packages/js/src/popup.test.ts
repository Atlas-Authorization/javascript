import { describe, it, expect } from 'vitest';
import { parseOAuthPopupMessage } from './redirect';

/**
 * §oauth popup mode — the message validator. The load-bearing guarantee: a
 * message is only ever trusted from the exact FAPI origin and only in one of our
 * shapes, so an unrelated postMessage on the page can't drive the sign-in.
 */
const FAPI = 'https://auth.restorehub.net';

describe('parseOAuthPopupMessage', () => {
  it('ignores a message from any other origin', () => {
    expect(
      parseOAuthPopupMessage('https://evil.example.com', FAPI, {
        type: 'atlas:oauth:complete',
        ticket: 't',
      }),
    ).toBeNull();
  });

  it('maps a complete message to a ticket + attemptId', () => {
    expect(
      parseOAuthPopupMessage(FAPI, FAPI, {
        type: 'atlas:oauth:complete',
        ticket: 'tk_1',
        attemptId: 'att_1',
      }),
    ).toEqual({ ticket: 'tk_1', attemptId: 'att_1' });
  });

  it('maps an error message to an error code + continuation', () => {
    expect(
      parseOAuthPopupMessage(FAPI, FAPI, {
        type: 'atlas:oauth:error',
        code: 'access_denied',
        continuationUrl: 'https://app/back?__atlas_error=access_denied',
      }),
    ).toEqual({ error: 'access_denied', continuationUrl: 'https://app/back?__atlas_error=access_denied' });
  });

  it('maps a continue (2FA/connect) message to status + attemptId', () => {
    expect(
      parseOAuthPopupMessage(FAPI, FAPI, {
        type: 'atlas:oauth:continue',
        status: 'needs_second_factor',
        attemptId: 'att_2',
        continuationUrl: 'https://app/back',
      }),
    ).toEqual({
      status: 'needs_second_factor',
      attemptId: 'att_2',
      continuationUrl: 'https://app/back',
    });
  });

  it('ignores unknown types and non-object payloads', () => {
    expect(parseOAuthPopupMessage(FAPI, FAPI, { type: 'something:else' })).toBeNull();
    expect(parseOAuthPopupMessage(FAPI, FAPI, 'a string')).toBeNull();
    expect(parseOAuthPopupMessage(FAPI, FAPI, null)).toBeNull();
  });
});
