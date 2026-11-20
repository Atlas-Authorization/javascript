#!/usr/bin/env bash
# ext-policyvm-bulk.sh [N_PER_SHARD] [SHARDS]   run the PolicyVm differential suite in SHARDS parallel processes (different seeds) on a leased
# cloud box against a SNAPSHOT of git HEAD:packages/pca (+ the working-tree verified-core). Prints one summary line per shard.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
N="${1:-100000}"; SHARDS="${2:-8}"
. "$ROOT/tools/pca-cloud/lib.sh"
CORES="${CORES:-8}" LEASE_TAG=pvm-bulk lease_enter
box_up || exit 1
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/packages/pca-verified-core"
(cd "$ROOT" && git archive HEAD packages/pca | tar -x -C "$STAGE"); cp "$ROOT/tsconfig.base.json" "$STAGE/"
rsync -a --exclude node_modules --exclude dist "$HERE/" "$STAGE/packages/pca-verified-core/"
rsh 'mkdir -p /work/pvm-stage'
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" "$STAGE/" "pca@$BOX_IP:/work/pvm-stage/"
rsh "cd /work/pvm-stage/packages && ln -sfn /work/ssoly/packages/pca/node_modules pca/node_modules && ln -sfn /work/ssoly/packages/pca-verified-core/node_modules pca-verified-core/node_modules && cd pca-verified-core && export PATH=\$HOME/.cargo/bin:\$PATH && \
  rm -f /work/logs/pvm-*.log; mkdir -p /work/logs; \
  for k in \$(seq 1 $SHARDS); do (PVM_N=$N PVM_SEED=\$((k*1009)) node /work/ssoly/packages/pca-verified-core/node_modules/vitest/vitest.mjs run --exclude '**/node_modules/**' test/ext-policyvm.diff.test.ts > /work/logs/pvm-\$k.log 2>&1; echo \"shard \$k exit=\$?\" >> /work/logs/pvm-summary.log) & done; wait; \
  cat /work/logs/pvm-summary.log; grep -h -E 'Tests |Duration' /work/logs/pvm-*.log"
