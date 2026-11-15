import type { Engine } from '../engine';
import { SNS_CERT_PATH } from '../sns-cert';
import type { Obj } from '../openapi';
import { engineState } from './support';

/** What the emulator knows about Amazon SNS: extra certificates a test registered, and subscription confirmations "visited". */
export const snsState = engineState((_e: Engine) => ({ certs: new Map<string, string>(), confirmations: [] as Obj[] }));

/** What fetching a SigningCertURL returns: a registered certificate for that exact URL, the built-in one at its own path, else nothing. */
export function snsCertificateFor(e: Engine, url: string, builtIn: string): string | null {
  const registered = snsState(e).certs.get(url);
  if (registered) return registered;
  try {
    return new URL(url).pathname === SNS_CERT_PATH ? builtIn : null;
  } catch {
    return null;
  }
}
