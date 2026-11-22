import type { AtlasClient } from './index';

type Atlas = Pick<AtlasClient, 'oauthClients'>;

export interface ProxyRequest {
  method: string;
  /** Path under your mount point: `login`, `login/accept`, `login/reject`, `consent`, `consent/accept`, `consent/reject`, `consent/switch_account`, `device`, `device/accept`, `device/reject`. */
  path: string;
  query: Record<string, string | undefined>;
  body?: unknown;
}
export interface ProxyResponse {
  status: number;
  body: unknown;
}

/**
 * The backend half of the browser helper `createDelegatedUiClient` (@atlasauth/js).
 * Mount it under any route; it forwards the challenge calls to Atlas with your
 * secret key. YOU must authenticate the visitor before letting an `accept`
 * through: pass `authorize` to decide (return the Atlas user id for a login
 * accept, or throw / return null to refuse).
 */
export function delegatedUiProxy(
  atlas: Atlas,
  opts: {
    /** Called for `login/accept`, `consent/accept` and `device/accept`; return the Atlas user id the visitor is, or null to refuse. */
    authorize: (req: ProxyRequest) => Promise<string | null> | string | null;
  },
) {
  return async function handle(req: ProxyRequest): Promise<ProxyResponse> {
    const login = req.query.login_challenge;
    const consent = req.query.consent_challenge;
    const device = req.query.device_challenge;
    const body = (req.body ?? {}) as Record<string, unknown>;
    try {
      const route = `${req.method.toUpperCase()} ${req.path.replace(/^\/|\/$/g, '')}`;
      if (route === 'GET login' && login) return { status: 200, body: await atlas.oauthClients.loginRequests.get(login) };
      if (route === 'GET consent' && consent) return { status: 200, body: await atlas.oauthClients.consentRequests.get(consent) };
      if (route === 'POST login/reject' && login) return { status: 200, body: await atlas.oauthClients.loginRequests.reject(login, body) };
      if (route === 'POST consent/reject' && consent) return { status: 200, body: await atlas.oauthClients.consentRequests.reject(consent, body) };
      if (route === 'GET device' && device) return { status: 200, body: await atlas.oauthClients.deviceRequests.get(device) };
      if (route === 'POST device/reject' && device) return { status: 200, body: await atlas.oauthClients.deviceRequests.reject(device) };
      if (route === 'POST consent/switch_account' && consent) return { status: 200, body: await atlas.oauthClients.consentRequests.switchAccount(consent) };
      if (route === 'POST device/accept' && device) {
        if (!(await opts.authorize(req))) return { status: 401, body: { error: { message: 'Not signed in.' } } };
        return { status: 200, body: await atlas.oauthClients.deviceRequests.accept(device) };
      }
      if (route === 'POST login/accept' && login) {
        const subject = await opts.authorize(req);
        if (!subject) return { status: 401, body: { error: { message: 'Not signed in.' } } };
        // The subject is decided by your authorize(), never by the browser.
        return { status: 200, body: await atlas.oauthClients.loginRequests.accept(login, { ...body, subject } as { subject: string }) };
      }
      if (route === 'POST consent/accept' && consent) {
        if (!(await opts.authorize(req))) return { status: 401, body: { error: { message: 'Not signed in.' } } };
        return { status: 200, body: await atlas.oauthClients.consentRequests.accept(consent, body) };
      }
      return { status: 404, body: { error: { message: 'Unknown route.' } } };
    } catch (e) {
      const status = (e as { status?: number }).status ?? 502;
      return { status, body: { error: { message: e instanceof Error ? e.message : 'Request failed.' } } };
    }
  };
}
