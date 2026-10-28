import type { TranslationResult } from '../framework/plugin';
import { isObj, type Obj } from './record-set';
import { ConfigBuilder } from './translate-kit';
import { VendorApiError, type VendorHttp } from './vendor-http';

/**
 * `atlas migrate corbado config` — Corbado exposes no settings API worth
 * reading, so the sign-in methods are inferred from what the project's users
 * actually have (login identifiers by type, from the Backend API) and the
 * rest is reported by where it lives in the Corbado console.
 */
export interface CorbadoConfigSnapshot {
  projectId: string;
  rpId?: string;
  /** Number of login identifiers by type; null when the count could not be read. */
  identifiers: { email: number | null; phone: number | null; username: number | null };
}

async function count(http: VendorHttp, type: 'email' | 'phone' | 'username'): Promise<number | null> {
  try {
    const { body } = await http.get<Obj>(`/v2/identifiers?page=1&pageSize=1&filter%5B%5D=${encodeURIComponent(`identifierType:eq:${type}`)}`);
    const total = isObj(body?.paging) ? body.paging.totalItems : undefined;
    return typeof total === 'number' ? total : null;
  } catch (err) {
    if (err instanceof VendorApiError && [400, 403, 404].includes(err.status)) return null;
    throw err;
  }
}

export async function fetchCorbadoConfig(http: VendorHttp, projectId: string, rpId?: string): Promise<CorbadoConfigSnapshot> {
  return {
    projectId,
    ...(rpId ? { rpId } : {}),
    identifiers: { email: await count(http, 'email'), phone: await count(http, 'phone'), username: await count(http, 'username') },
  };
}

export function translateCorbadoConfig(snap: CorbadoConfigSnapshot): TranslationResult {
  const b = new ConfigBuilder();
  b.set('strategies.passkey', true);
  b.add('mapped', 'authentication', 'passkeys', 'Passkey sign-in stays on; exported credentials keep working while Atlas is served from the same relying-party domain.', 'auth_config.strategies.passkey');
  b.set('accountUx.passkeySignUp.enabled', true);
  b.add('mapped', 'authentication', 'passkey-first sign-up', 'Corbado accounts start from a passkey: Atlas offers passkey sign-up.', 'auth_config.accountUx.passkeySignUp');
  const { email, phone, username } = snap.identifiers;
  if (email) {
    b.set('strategies.emailCode', true);
    b.add('mapped', 'identifiers', 'email', `${email} email identifier(s): email code sign-in (the fallback when a passkey is not available).`, 'auth_config.strategies.emailCode');
  }
  if (phone) {
    b.set('strategies.phoneCode', true);
    b.add('mapped', 'identifiers', 'phone', `${phone} phone identifier(s): SMS code sign-in.`, 'auth_config.strategies.phoneCode');
  }
  if (username) {
    b.set('strategies.username', true);
    b.add('mapped', 'identifiers', 'username', `${username} username identifier(s).`, 'auth_config.strategies.username');
  }
  if (email === null && phone === null && username === null) {
    b.add('manual', 'identifiers', 'login identifiers', 'Corbado did not list your identifiers; turn on the matching Atlas sign-in methods (emailCode, phoneCode, username) yourself.', 'auth_config.strategies');
  }
  if (snap.rpId) b.add('differs', 'passkeys', 'relying party', `Passkeys are bound to ${snap.rpId}: serve Atlas from that domain or a subdomain (a custom domain) so exported passkeys keep working.`);
  else b.add('manual', 'passkeys', 'relying party', 'Corbado does not return the relying-party id: pass it with --corbado-rp-id so passkeys can be exported, and serve Atlas from that domain.');
  for (const [setting, where] of [
    ['allowed origins and redirect URLs', 'Developer panel → Application URLs'],
    ['session lifetimes (short and long session)', 'Developer panel → Sessions'],
    ['social login', 'Developer panel → Authentication methods'],
    ['webhooks and email / SMS templates', 'Developer panel → Webhooks, Communication'],
  ] as const) {
    b.add('manual', 'settings not in the API', setting, `Corbado does not expose this by API; copy it from the Corbado console (${where}). Atlas: dashboard → Sessions / Redirect URLs / Providers / Webhooks.`);
  }
  return b.result(`Corbado project ${snap.projectId}`, { bridge: { preset: 'corbado', vars: { project_id: snap.projectId } } });
}
