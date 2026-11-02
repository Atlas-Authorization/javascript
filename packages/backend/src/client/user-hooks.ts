import type { RequestFn } from './request';

/**
 * The `before_user_create` hook: just before Atlas creates a user from an
 * interactive sign-up, it calls your endpoint (signed exactly like a webhook:
 * `atlas-id`, `atlas-timestamp`, `atlas-signature`, verify with
 * {@link verifyWebhook}) with an event of type `user.before_create`, and stamps
 * the `external_id` and metadata you answer. A referral call then goes out
 * with your id. Slow or failing hooks do not block a sign-up unless the hook
 * is set `fail_closed`.
 *
 * Answer `{ external_id?, public_metadata?, private_metadata?, unsafe_metadata? }`,
 * or refuse the sign-up with `{ deny: true, reason? }` (or HTTP 403): the
 * person gets 403 `SIGN_UP_DENIED` with your reason and no user is kept.
 */

export interface BeforeUserCreateHook {
  object: 'before_user_create_hook';
  enabled: boolean;
  url: string | null;
  /** The secret is write-only. */
  signing_secret_set: boolean;
  /** At most 5000, default 3000. */
  timeout_ms: number;
  /** Refuse the sign-up when the hook times out, errors or answers badly. Default false. */
  fail_closed: boolean;
  /** The last call Atlas made to the hook. */
  last_call: { at: number; status: string | null; error: string | null } | null;
  updated_at: number | null;
}

export interface UpdateBeforeUserCreateHookBody {
  enabled?: boolean;
  /** https (http only for localhost on a development instance); `null` clears. */
  url?: string | null;
  /** Write-only; `null` clears. */
  signing_secret?: string | null;
  timeout_ms?: number;
  fail_closed?: boolean;
  /**
   * Skip the signed test call that turning the hook on (or changing the url or
   * signing_secret of an enabled one) otherwise makes first; without it a hook
   * that does not answer is refused with 409 `HOOK_TEST_FAILED`.
   */
  force?: boolean;
}

/** `data.request` of a `user.before_create` call: the authorize request behind the sign-up (null for each absent value). */
export interface BeforeUserCreateRequestContext {
  client_id: string | null;
  /** The authorize request's `app_context` (opaque, at most 512 bytes). Browser-supplied: verify it. */
  app_context: string | null;
  login_hint: string | null;
}

/** `data.invitation` of a `user.before_create` call: the pending instance invitation for the sign-up address. */
export interface BeforeUserCreateInvitation {
  id: string;
  email: string;
  public_metadata: Record<string, unknown>;
  /** Alias of `public_metadata`. */
  app_metadata: Record<string, unknown>;
  /** Whether the address is proven yet; the metadata lands on the user once it is. */
  email_verified: boolean;
}

/** The body Atlas posts to a `before_user_create` hook (verify it with `verifyWebhook` first). */
export interface BeforeUserCreateEvent {
  object: 'event';
  id: string;
  type: 'user.before_create';
  timestamp: number;
  instance_id: string;
  /** true only for a test call (`POST …/test`): answer, but reserve nothing. */
  test: boolean;
  data: {
    user: {
      id: string;
      external_id: string | null;
      first_name: string | null;
      last_name: string | null;
      username: string | null;
      email_addresses: string[];
      phone_numbers: string[];
      public_metadata: Record<string, unknown>;
      unsafe_metadata: Record<string, unknown>;
      created_at: number;
    };
    strategy: string;
    referral: Record<string, unknown> | null;
    request: BeforeUserCreateRequestContext;
    invitation: BeforeUserCreateInvitation | null;
  };
}

/** `POST …/test`: a sample draft sent to the hook; nothing is stored. */
export interface BeforeUserCreateHookTest {
  ok: boolean;
  latency_ms: number;
  answer?: {
    /** Set when the hook denied the sample sign-up. */
    deny?: true;
    reason?: string | null;
    external_id?: string | null;
    public_metadata?: Record<string, unknown> | null;
    private_metadata_set?: boolean;
    unsafe_metadata?: Record<string, unknown> | null;
  };
  error?: { code: string; message: string };
}

const PATH = '/v1/instance/hooks/before_user_create';

export function userHooksResource(request: RequestFn) {
  return {
    /** `GET /v1/instance/hooks/before_user_create`. */
    getBeforeUserCreate(): Promise<BeforeUserCreateHook> {
      return request({ method: 'GET', path: PATH });
    },
    /** `PATCH /v1/instance/hooks/before_user_create` — partial; the secret is write-only. */
    updateBeforeUserCreate(body: UpdateBeforeUserCreateHookBody): Promise<BeforeUserCreateHook> {
      return request({ method: 'PATCH', path: PATH, body });
    },
    /** `POST /v1/instance/hooks/before_user_create/test`. */
    testBeforeUserCreate(): Promise<BeforeUserCreateHookTest> {
      return request({ method: 'POST', path: `${PATH}/test` });
    },
  };
}
