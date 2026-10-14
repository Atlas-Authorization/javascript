import { describe, expect, it } from 'vitest';
import { createPkcePair, createState } from './pkce';

describe('createPkcePair', () => {
  it('derives an S256 challenge from the verifier (base64url, no padding)', async () => {
    const { verifier, challenge } = await createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(verifier).not.toContain('=');
    expect(challenge).not.toContain('=');

    // Re-derive the challenge from the verifier and confirm it matches.
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    const bytes = new Uint8Array(digest);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    const expected = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(challenge).toBe(expected);
  });

  it('is random each call', async () => {
    const a = await createPkcePair();
    const b = await createPkcePair();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

describe('createState', () => {
  it('mints a random base64url state', () => {
    expect(createState()).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(createState()).not.toBe(createState());
  });
});
