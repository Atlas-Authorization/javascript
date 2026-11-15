import type { Engine, RouteDef } from '../engine';
import { emu4AuthHandlers } from './emu4-oauth-auth';
import { emu4DeliveryHandlers, runDueDeliveries } from './emu4-oauth-delivery';
import { signingKeyHandlers, runSigningSchedule } from './emu4-oauth-keys';
import { emu4PublisherHandlers } from './emu4-oauth-pub';

/**
 * Round-four OAuth routes: instance signing algorithms and the rotation schedule, request-object encryption,
 * private_key_jwt client authentication, form_post and JARM response modes, retried back-channel logout and CIBA
 * delivery, verified publishers, the Google access-token exchange and the registration extensions (software statements,
 * pairwise subjects). Their wiring into the advanced provider lives in the modules they extend.
 */
export function emu4OauthHandlers(): RouteDef[] {
  return [...signingKeyHandlers(), ...emu4DeliveryHandlers(), ...emu4PublisherHandlers(), ...emu4AuthHandlers()];
}

/** Everything the clock made due: the key rotation schedule, then delivery retries. Runs on every `time/advance`. */
export async function runOAuthClockWork(e: Engine): Promise<void> {
  await runSigningSchedule(e);
  await runDueDeliveries(e);
}
