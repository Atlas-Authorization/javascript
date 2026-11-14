import type { RouteDef } from '../engine';
import { accessHandlers } from './access';
import { controlHandlers } from './control';
import { hooksHandlers } from './hooks';
import { keysHandlers } from './keys';
import { machinesHandlers } from './machines';
import { orgsHandlers } from './orgs';
import { sessionsHandlers } from './sessions';
import { usersHandlers } from './users';

export function allHandlers(): RouteDef[] {
  return [...usersHandlers(), ...orgsHandlers(), ...accessHandlers(), ...keysHandlers(), ...machinesHandlers(), ...hooksHandlers(), ...sessionsHandlers(), ...controlHandlers()];
}

export { seedAccess } from './access';
export { installPresenters, resetConsumers } from './hooks';
export { resetUsage } from './machines';
export { resetSessions } from './sessions';
