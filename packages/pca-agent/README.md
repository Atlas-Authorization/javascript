# @atlasauth/pca-agent

Agent-side client for Proof-Carrying Authority. It builds the plan commitment, PCActn and threshold share for you.

```ts
import { createAgent } from '@atlasauth/pca-agent';

const agent = createAgent({ grant, agentSecret, agentPublic, rsBaseUrl: 'https://rs.example.com' });
await agent.commitPlan([{ id: 'n1', verb: 'read', resource: 'doc:1' }]);
const r = await agent.act('n1', { page: 2 });
if (r.status === 'step_up') await agent.awaitStepUp(r.stepupId);   // human approval
else if (r.status === 'allowed') agent.verifyReceipt(r.receipt);   // true
```

- `act()` never throws for deny or step-up; it returns `allowed | denied | step_up | error`.
- `delegate({ toPublic, addedCaveats, agentSecret })` returns a sub-agent client with strictly lesser authority.
- `fetch` is injectable (`createAgent({ ..., fetch })`).
