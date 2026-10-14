# @atlasauth/pca changelog

## 0.1.0

First published release.

### Added
- Proof-Carrying Authority core: canonical JSON hashing (`canonicalize()`, `hashCanonical()`), Ed25519 keys and signatures (`generateKeyPair()`, `sign()`, `verify()`), and Merkle plan commitments (`commitPlan()`, `merkleProof()`, `verifyInclusion()`).
- Attenuable capability chains (`mintRoot()`, `attenuate()`, `delegate()`, `verifyChain()`) and the proof-carrying action credential (`buildPCActn()`, `signPCActn()`, `encodePCActn()` / `decodePCActn()`, `verifyPCActnCore()`).
- Root intent grants (`mintGrant()`, `readEnvelope()`), caveat and predicate evaluation, a deterministic policy engine (`decide()`, `deriveDecideInput()`), and a risk functional with trust budgets and risk-adaptive signing thresholds (`riskScore()`, `requiredThreshold()`, `admit()`).
- Threshold signatures: t-of-n Ed25519 share assembly (`assembleThreshold()`, `verifyThreshold()`), FROST (Ed25519, SHA-512) aggregated signatures per RFC 9591 (`frostCommit()`, `frostSign()`, `frostAggregate()`), and dealer-free FROST distributed key generation with complaint, rebuttal and blame rounds (`dkgRound1()` through `dkgFinalize()`).
- Transparency ledger with inclusion and consistency proofs and equivocation detection (`TransparencyLedger`), revocation sets with membership / non-membership proofs (`RevocationSet`, `createRevocationChecker()`), and dead-man beacons (`issueBeacon()`, `verifyBeacon()`, `isFrozen()`).
- Execution attestation (`createAttestationVerifier()`), including an AMD SEV-SNP hardware report verifier (`createSevSnpVerifier()`, `verifySevSnpReportSignature()`, `verifyVcekChain()`).
- Optimistic execution with challenge windows and fraud proofs (`openOptimistic()`, `fileFraudProof()`, `verifyFraudProof()`), bond settlement including slashing on revocation (`BondLedger`, `verifySettlement()`), and compliance-proof commitments (`policyCommitment()`, `createZkVerifier()`).
- Cross-language conformance vectors and a runnable end-to-end example.
