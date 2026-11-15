/**
 * Wallet verifier, browser side (OpenID4VP over the Digital Credentials API).
 *
 * Your server creates a presentation request with `response_mode: "dc_api"` (`atlas.vc.presentationRequests.create`),
 * reads its `dc_api_request` and hands that to the page. {@link presentToVerifier} asks the user's wallet through
 * `navigator.credentials.get({ digital })` and posts the wallet's answer to the request's `response_endpoint`, where
 * Atlas checks it (issuer signature, holder binding, nonce, revocation). The page learns only whether the wallet
 * answered; the verified claims go to your server, which reads them with `presentationRequests.get`.
 *
 * Nothing here throws: every outcome is a {@link WalletPresentationResult}, so a missing wallet or a cancelled prompt
 * is a case to handle, not a crash. SSR-safe: nothing runs until you call it.
 */

/** What `GET /v1/vc/presentation_requests/{id}/dc_api_request` returns. */
export interface DcApiRequest {
  /** `openid4vp-v1-signed` or `openid4vp-v1-unsigned`. */
  protocol: string;
  /** The request parameters (or `{ request }` with a signed request object). */
  data: Record<string, unknown>;
  /** Where the page posts the wallet's answer. */
  response_endpoint: string;
}

export type WalletPresentationResult =
  | { ok: true }
  | { ok: false; error: 'unsupported' | 'cancelled' | 'wallet_error' | 'rejected'; message: string };

interface DigitalCredentialsContainer {
  get(options: Record<string, unknown>): Promise<{ data?: unknown } | null>;
}

export interface PresentOptions {
  /** Abort the wallet prompt. */
  signal?: AbortSignal;
  /** Injectable for tests; defaults to `navigator.credentials`. */
  credentials?: DigitalCredentialsContainer;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
}

const defaultCredentials = (): DigitalCredentialsContainer | undefined =>
  typeof navigator !== 'undefined' ? (navigator as unknown as { credentials?: DigitalCredentialsContainer }).credentials : undefined;

/** True when the browser can ask a wallet (it exposes the Digital Credentials API). */
export function walletPresentationSupported(win: { DigitalCredential?: unknown } | undefined = typeof window !== 'undefined' ? (window as unknown as { DigitalCredential?: unknown }) : undefined): boolean {
  return !!win && typeof win.DigitalCredential !== 'undefined' && !!defaultCredentials();
}

/** Ask the wallet for the credential a presentation request describes, and deliver its answer to Atlas. */
export async function presentToVerifier(request: DcApiRequest, options: PresentOptions = {}): Promise<WalletPresentationResult> {
  const credentials = options.credentials ?? defaultCredentials();
  if (!credentials) return { ok: false, error: 'unsupported', message: 'This browser cannot ask a wallet for a credential.' };

  let answer: { data?: unknown } | null;
  try {
    answer = await credentials.get({
      digital: { requests: [{ protocol: request.protocol, data: request.data }] },
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (e) {
    const name = (e as { name?: string })?.name;
    // The user closing the wallet prompt (NotAllowedError) or aborting (AbortError) is not a failure to report loudly.
    if (name === 'NotAllowedError' || name === 'AbortError') return { ok: false, error: 'cancelled', message: 'The wallet prompt was closed.' };
    return { ok: false, error: 'wallet_error', message: (e as Error)?.message || 'The wallet could not answer.' };
  }
  if (!answer || answer.data === undefined) return { ok: false, error: 'wallet_error', message: 'The wallet returned no data.' };

  let data = answer.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return { ok: false, error: 'wallet_error', message: 'The wallet answer was not JSON.' };
    }
  }

  try {
    const res = await (options.fetchImpl ?? fetch)(request.response_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ data }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (res.ok) return { ok: true };
    let message = 'Atlas did not accept the wallet answer.';
    try {
      const body = (await res.json()) as { error_description?: unknown };
      if (typeof body.error_description === 'string') message = body.error_description;
    } catch {
      /* keep the generic message */
    }
    return { ok: false, error: 'rejected', message };
  } catch {
    return { ok: false, error: 'rejected', message: 'The answer could not be delivered to Atlas.' };
  }
}
