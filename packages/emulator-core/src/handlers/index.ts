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
import { revocationsHandlers } from './revocations';
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
import { authzDataHandlers } from './authz-data';
import { emu3MiscHandlers } from './emu3-misc';
import { oauthAdvHandlers } from './oauth-adv';
import { emu4FederationHandlers, installSaml } from './emu4-federation';
import { emu4ComplianceHandlers } from './emu4-compliance';
import { emu4TrustHandlers } from './emu4-trust';
import { emu4MessagingHandlers } from './emu4-messaging';
import { emu4BillingHandlers, installBillingWebhooks } from './emu4-billing';
import { emu4ActionsHandlers } from './emu4-actions';
import { emu4OauthHandlers } from './emu4-oauth';
import { emu4AuthzHandlers } from './emu4-authz';
import { domainsHandlers } from './domains';
import { ndbMiscHandlers } from './ndb-misc';
import { ndbPcaHandlers } from './ndb-pca';
import { ndbOrgHandlers } from './ndb-org';

export function allHandlers(): RouteDef[] {
  return [...usersHandlers(), ...orgsHandlers(), ...accessHandlers(), ...keysHandlers(), ...revocationsHandlers(), ...machinesHandlers(), ...hooksHandlers(), ...sessionsHandlers(), ...controlHandlers(), ...deviceHandlers(), ...oauthHandlers(), ...scimHandlers(), ...passkeyHandlers(), ...round2Handlers(), ...federationHandlers(), ...oauthFlowHandlers(), ...approvalsHandlers(), ...governanceHandlers(), ...messagingHandlers(), ...billingHandlers(), ...workflowHandlers(), ...platformHandlers(), ...connectionsHandlers(), ...authzDataHandlers(), ...oauthAdvHandlers(), ...emu3MiscHandlers(), ...emu4AuthzHandlers(), ...emu4ActionsHandlers(), ...emu4MessagingHandlers(), ...emu4BillingHandlers(), ...emu4OauthHandlers(), ...emu4ComplianceHandlers(), ...emu4FederationHandlers(), ...emu4TrustHandlers(), ...domainsHandlers(), ...ndbMiscHandlers(), ...ndbPcaHandlers(), ...ndbOrgHandlers()];
}

export { seedAccess } from './access';
export { resetConsumers } from './hooks';

/** Installs what the engine reads at construction: feed presenters and the messaging route on the message sink. */
export function installPresenters(e: import('../engine').Engine): void {
  installFeedPresenters(e);
  installMessaging(e);
  installSaml(e);
  installBillingWebhooks(e);
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
