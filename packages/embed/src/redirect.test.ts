import { describe, expect, it } from 'vitest';
import { validateRedirect } from './redirect';

/**
 * The embedded surface is dropped onto a page the tenant does not fully
 * control, so its post-sign-in destination is exactly the kind of thing an
 * attacker tries to bend into an open redirect. These tests pin the gate.
 */
describe('validating a widget redirect', () => {
  const ORIGIN = 'https://app.customer.com';

  it('accepts a rooted relative path (stays same-origin)', () => {
    expect(validateRedirect('/dashboard', ORIGIN)).toBe('https://app.customer.com/dashboard');
  });

  it('accepts a same-origin absolute URL', () => {
    expect(validateRedirect('https://app.customer.com/welcome', ORIGIN)).toBe(
      'https://app.customer.com/welcome',
    );
  });

  it('accepts an absolute https URL on another origin (explicitly supplied)', () => {
    expect(validateRedirect('https://other.example.com/next', ORIGIN)).toBe(
      'https://other.example.com/next',
    );
  });

  it('rejects a cross-origin http downgrade', () => {
    expect(validateRedirect('http://evil.example.com', ORIGIN)).toBeNull();
  });

  it('rejects a protocol-relative URL', () => {
    // `//evil.com` resolves cross-origin under the page's scheme — never allowed.
    expect(validateRedirect('//evil.com/steal', ORIGIN)).toBeNull();
  });

  it('rejects a javascript: scheme', () => {
    expect(validateRedirect('javascript:alert(1)', ORIGIN)).toBeNull();
  });

  it('rejects a data: scheme', () => {
    expect(validateRedirect('data:text/html,<script>alert(1)</script>', ORIGIN)).toBeNull();
  });

  it('rejects empty and non-string input', () => {
    expect(validateRedirect('', ORIGIN)).toBeNull();
    expect(validateRedirect(null, ORIGIN)).toBeNull();
    expect(validateRedirect(undefined, ORIGIN)).toBeNull();
  });
});
