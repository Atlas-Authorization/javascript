# @atlasauth/pdp

A local policy decision point for Atlas. It verifies a signed policy bundle offline, then evaluates ABAC (Cedar-subset) policies and FGA relationship checks in-process, or as a localhost sidecar. No call to Atlas sits on the decision path.

```ts
import { LocalPdp, PdpSync, DecisionShipper } from '@atlasauth/pdp';

const pdp = new LocalPdp();
new PdpSync({ pdp, baseUrl: process.env.ATLAS_API_URL!, apiKey: process.env.ATLAS_API_KEY!, jwks: pinnedJwks }).start();

const { decision } = await pdp.authorize({
  principal: { type: 'User', id: 'alice' },
  action: { id: 'read' },
  resource: { type: 'Doc', id: '1' },
});
```

- The bundle is the trust anchor: a bad signature, an unknown key, a tampered file or an unexpected revision is refused. Pin the signing keys (`jwks`) in production.
- Tuples follow the store: a full snapshot, then changes since the last revision. A tuple with an expiry stops granting at that instant even if the sync is behind.
- `pdp.onDecision` plus `DecisionShipper` batch decisions back to Atlas (`/v1/authz_decisions/ingest`), which also puts the PDP in the fleet list with the bundle revision it runs.

## Sidecar

```sh
docker run -p 127.0.0.1:8181:8181 \
  -e ATLAS_API_URL=https://api.example.com -e ATLAS_API_KEY=sk_live_... \
  -e ATLAS_JWKS_FILE=/keys/jwks.json -e ATLAS_PDP_TOKEN=change-me atlasauth/pdp
```

The sidecar refuses to start until a bundle has verified. It serves AuthZEN (`POST /access/v1/evaluation`, `/evaluations`), `POST /v1/abac/authorize`, and OpenFGA-shaped `POST /stores/{name}/check` and `/list-objects` (store names are the bundle's FGA store names), plus `GET /healthz`.
