#!/usr/bin/env bash
# test-on-head.sh [vitest args...]
# Runs this package's tests on a cloud box against a SNAPSHOT of `git HEAD:packages/pca` (committed, coherent source)
# instead of the live working tree (which other agents may be mid-edit). Set PCA_SRC=live to use the working tree.
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
. "$ROOT/tools/pca-cloud/lib.sh"
lease_enter
box_up || exit 1
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/packages/pca-verified-core"
if [ "${PCA_SRC:-head}" = live ]; then rsync -a --exclude node_modules --exclude dist --exclude .stryker-tmp "$ROOT/packages/pca/" "$STAGE/packages/pca/"
else (cd "$ROOT" && git archive HEAD packages/pca | tar -x -C "$STAGE"); fi
cp "$ROOT/tsconfig.base.json" "$STAGE/"
rsync -a --exclude node_modules --exclude dist "$HERE/" "$STAGE/packages/pca-verified-core/"
rsh 'mkdir -p /work/vc-stage'
rsync -az --delete -e "ssh ${SSH_OPTS[*]}" "$STAGE/" "pca@$BOX_IP:/work/vc-stage/"
ARGS="$(printf '%q ' "$@")"
rsh "cd /work/vc-stage/packages && ln -sfn /work/ssoly/packages/pca/node_modules pca/node_modules && ln -sfn /work/ssoly/packages/pca-verified-core/node_modules pca-verified-core/node_modules && cd pca-verified-core && export PATH=\$HOME/.cargo/bin:\$PATH && node /work/ssoly/packages/pca-verified-core/node_modules/vitest/vitest.mjs run --exclude '**/node_modules/**' $ARGS"
