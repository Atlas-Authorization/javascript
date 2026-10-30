import type { RequestFn } from './request';
import type { BrowserTicket } from './sessions';

/** The production instance's paired development (test-mode) sibling. */
export interface TestInstance {
  object: 'test_instance';
  instance_id: string;
  environment: 'development';
  publishable_key: string;
  /** True when this call created the sibling. */
  created: boolean;
  /** The `sk_test_…` — returned ONLY on create or rotate. Store it now. */
  secret_key?: string;
}

export interface TestUsersPurgeResult {
  object: string;
  purged: number;
  /** Loop until this is false. */
  has_more: boolean;
}

/** A short-lived token that lets `@atlasauth/testing` skip the sign-in CAPTCHA. */
export interface TestingToken {
  object: 'testing_token';
  jwt: string;
  token_use: 'testing';
  /** Lifetime in seconds. */
  expires_in: number;
}

/** A one-time URL that signs a browser in as a user (`POST /v1/testing/sign_in_url`). */
export interface TestingSignInUrl extends Omit<BrowserTicket, 'object' | 'url' | 'redirect_url'> {
  object: 'testing_sign_in_url';
  url: string;
  redirect_url: string;
}

export function testModeResource(request: RequestFn) {
  return {
    /**
     * Get (creating on first call) the paired development instance. Call with
     * the LIVE instance's secret key. `rotate_secret: true` mints a fresh `sk_test`.
     */
    testInstance(body: { rotate_secret?: boolean } = {}): Promise<TestInstance> {
      return request({ method: 'POST', path: '/v1/test_instance', body });
    },
    /**
     * Soft-delete users whose email carries a reserved test marker
     * (`+atlas_test`, `+clerk_test`). Development instances only.
     */
    purgeTestUsers(body: { limit?: number } = {}): Promise<TestUsersPurgeResult> {
      return request({ method: 'POST', path: '/v1/test_users/purge', body });
    },
    /** Mint a testing token. Development instances only (403 TESTING_UNAVAILABLE otherwise). */
    createTestingToken(): Promise<TestingToken> {
      return request({ method: 'POST', path: '/v1/testing_tokens' });
    },
    /**
     * A ready one-time URL that signs a browser in as `user_id` and lands on
     * `redirect_url` (an allowed origin or localhost). Development instances only
     * (403 TESTING_UNAVAILABLE otherwise). `@atlasauth/testing` wraps it as `signInAs`.
     */
    createSignInUrl(body: { user_id: string; redirect_url: string; expires_in_seconds?: number }): Promise<TestingSignInUrl> {
      return request({ method: 'POST', path: '/v1/testing/sign_in_url', body });
    },
  };
}
