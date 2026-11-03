import { describe, expect, it } from 'vitest';
import { CSRF_COOKIE, checkCsrfToken, csrfToken, deriveCsrfSecret, verifyCsrf } from './csrf';

const secret = 'test-secret-0123456789abcdef';
const opts = { sid: 'sess_1', secret };

function req(init: { token?: string; cookie?: string; form?: string }) {
  const headers: Record<string, string> = {};
  if (init.cookie !== undefined) headers.cookie = `${CSRF_COOKIE}=${encodeURIComponent(init.cookie)}; other=1`;
  if (init.token !== undefined) headers['x-atlas-csrf'] = init.token;
  if (init.form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
  return new Request('https://app.test/x', { method: 'POST', headers, body: init.form });
}

describe('csrf', () => {
  it('a token verifies for its own session only', () => {
    const t = csrfToken(opts);
    expect(checkCsrfToken(t, opts)).toBe(true);
    expect(checkCsrfToken(t, { ...opts, sid: 'sess_2' })).toBe(false);
    expect(checkCsrfToken(t, { ...opts, secret: `${secret}x` })).toBe(false);
    expect(checkCsrfToken(`${t}x`, opts)).toBe(false);
    expect(checkCsrfToken('', opts)).toBe(false);
    expect(csrfToken(opts)).not.toBe(t);
  });

  it('header + matching cookie passes', async () => {
    const t = csrfToken(opts);
    expect(await verifyCsrf(req({ token: t, cookie: t }), opts)).toBe(true);
  });

  it('form field + matching cookie passes, and the body stays readable', async () => {
    const t = csrfToken(opts);
    const r = req({ cookie: t, form: `atlas_csrf=${encodeURIComponent(t)}&a=1` });
    expect(await verifyCsrf(r, opts)).toBe(true);
    expect(await r.text()).toContain('a=1');
  });

  it('refuses a missing token, a missing cookie, a mismatch, and another session\'s token', async () => {
    const t = csrfToken(opts);
    expect(await verifyCsrf(req({ cookie: t }), opts)).toBe(false);
    expect(await verifyCsrf(req({ token: t }), opts)).toBe(false);
    expect(await verifyCsrf(req({ token: t, cookie: csrfToken(opts) }), opts)).toBe(false);
    const other = csrfToken({ ...opts, sid: 'sess_2' });
    expect(await verifyCsrf(req({ token: other, cookie: other }), opts)).toBe(false);
  });

  it('derives a stable secret from the secret key', () => {
    expect(deriveCsrfSecret('sk_test_a')).toBe(deriveCsrfSecret('sk_test_a'));
    expect(deriveCsrfSecret('sk_test_a')).not.toBe(deriveCsrfSecret('sk_test_b'));
    expect(deriveCsrfSecret('sk_test_a')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('rejects a weak secret', () => {
    expect(() => csrfToken({ sid: 's', secret: 'short' })).toThrow(TypeError);
  });
});
