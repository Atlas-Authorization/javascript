# @atlasauth/pca

Proof-Carrying Authority (PCA) core: the building blocks for verifying that an action was authorized, rather than only that a token is valid.

It provides canonical hashing, Ed25519 keys, Merkle plan commitments, attenuable capability chains (a delegate can only narrow what it was given) and the verifier for a proof-carrying action. Threshold signing, attestation, envelopes and a policy VM are included as separate modules.

PCA is a preview. The hosted `/v1/pca/*` routes are off by default for an instance; the library has no network dependency and runs wherever you verify. Start with the Proof-Carrying Authority guide in the Atlas docs, which explains the model and the verification steps.

```ts
import * as pca from '@atlasauth/pca';
```
