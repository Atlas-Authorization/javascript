import { describe, expect, it } from 'vitest';
import { readRedirectResult, stripRedirectParams } from './redirect';

describe('readRedirectResult', () => {
  it('reads a completed sign-in — attempt + ticket, no leftover status', () => {
    const r = readRedirectResult('?__atlas_attempt=sia_1&__atlas_ticket=tkt_abc');
    expect(r).toEqual({ attemptId: 'sia_1', ticket: 'tkt_abc' });
    expect(r?.status).toBeUndefined();
  });

  it('reads a step-remaining redirect — status, and crucially NO ticket', () => {
    // The whole point of the MFA gate: a needs_second_factor redirect must not
    // carry a ticket, so the SDK cannot mistake it for a completed session.
    const r = readRedirectResult('?__atlas_attempt=sia_2&__atlas_status=needs_second_factor');
    expect(r).toEqual({ attemptId: 'sia_2', status: 'needs_second_factor' });
    expect(r?.ticket).toBeUndefined();
  });

  it('tolerates a search string with no leading question mark', () => {
    expect(readRedirectResult('__atlas_attempt=sia_3&__atlas_ticket=t')).toEqual({
      attemptId: 'sia_3',
      ticket: 't',
    });
  });

  it('is null when there is no Atlas redirect at all', () => {
    expect(readRedirectResult('')).toBeNull();
    expect(readRedirectResult('?foo=bar&baz=1')).toBeNull();
  });

  it('is null for an attempt id ALONE — not actionable, must not half-start', () => {
    // Neither a ticket nor a status: nothing to do. Treating this as a redirect
    // would strand the SDK waiting on a step that will never come.
    expect(readRedirectResult('?__atlas_attempt=sia_4')).toBeNull();
  });
});

describe('stripRedirectParams', () => {
  it('removes every Atlas param and keeps the customer’s own query', () => {
    const cleaned = stripRedirectParams(
      'https://app.example.com/dashboard?tab=billing&__atlas_attempt=sia_1&__atlas_ticket=t&__atlas_status=x',
    );
    const url = new URL(cleaned);
    expect(url.searchParams.get('tab')).toBe('billing');
    expect(url.searchParams.get('__atlas_attempt')).toBeNull();
    expect(url.searchParams.get('__atlas_ticket')).toBeNull();
    expect(url.searchParams.get('__atlas_status')).toBeNull();
    expect(url.pathname).toBe('/dashboard');
  });

  it('leaves a URL without Atlas params unchanged in substance', () => {
    const url = new URL(stripRedirectParams('https://app.example.com/x?a=1'));
    expect(url.searchParams.get('a')).toBe('1');
  });
});
