import type { RouteDef } from '../engine';
import { accessHandlers } from './access';
import { controlHandlers } from './control';
import { approvalsHandlers } from './approvals';
import { billingHandlers } from './billing';
import { connectionsHandlers } from './connections';
import { deviceHandlers, resetDevice } from './device';
import { federationHandlers } from './federation';
import { governanceHandlers } from './governance';
import { hooksHandlers, installPresenters as installFeedPresenters } from './hooks';
import { keysHandlers } from './keys';
import { machinesHandlers } from './machines';
import { installMessaging, messagingHandlers } from './messaging';
import { oauthHandlers, resetOAuth } from './oauth';
import { oauthFlowHandlers } from './oauth-flows';
import { orgsHandlers } from './orgs';
import { passkeyHandlers, resetPasskeys } from './passkeys';
import { platformHandlers } from './platform';
import { resetRound2Handlers, round2Handlers } from './round2';
import { scimHandlers } from './scim';
import { sessionsHandlers } from './sessions';
import { resetSupport } from './support';
import { usersHandlers } from './users';
import { workflowHandlers } from './workflows';

export function allHandlers(): RouteDef[] {
  return [...usersHandlers(), ...orgsHandlers(), ...accessHandlers(), ...keysHandlers(), ...machinesHandlers(), ...hooksHandlers(), ...sessionsHandlers(), ...controlHandlers(), ...deviceHandlers(), ...oauthHandlers(), ...scimHandlers(), ...passkeyHandlers(), ...round2Handlers(), ...federationHandlers(), ...oauthFlowHandlers(), ...approvalsHandlers(), ...governanceHandlers(), ...messagingHandlers(), ...billingHandlers(), ...workflowHandlers(), ...platformHandlers(), ...connectionsHandlers()];
}

export { seedAccess } from './access';
export { resetConsumers } from './hooks';

/** Installs what the engine reads at construction: feed presenters and the messaging route on the message sink. */
export function installPresenters(e: import('../engine').Engine): void {
  installFeedPresenters(e);
  installMessaging(e);
}
export { resetUsage } from './machines';
export { resetSessions } from './sessions';

/** Clears the state the second-round handler modules keep per engine. */
export function resetRound2(e: import('../engine').Engine): void {
  resetDevice(e);
  resetOAuth(e);
  resetPasskeys(e);
  resetRound2Handlers(e);
  resetSupport(e);
}
