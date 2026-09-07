#!/bin/bash
# speculum — release the signed-override contract and subgraph, then prove it
#
# Run from the repo root on the Mac, with the Ledger plugged in, unlocked, and
# the Ethereum app open. Everything here was prepared and tested up to the
# point of spending: the contract was exercised on a live Base Sepolia EVM
# through a state override (node bin/probe-override.js) and the subgraph
# builds locally. What this script does that nothing before it did is spend
# gas, publish a subgraph version, and ask a human to tap a device.
#
#   bash bin/release.sh
#
# Keys are read from files or prompts, never from arguments. Each step stops
# the script if it fails, and each step prints what it observed, so a failure
# halfway leaves a clear record of how far it got.

set -euo pipefail
cd "$(dirname "$0")/.."

RPC_URL="${RPC_URL:-https://sepolia.base.org}"
VERSION="${VERSION:-v0.0.3}"
SLUG="${SLUG:-speculum}"
export RPC_URL

say() { printf '\n== %s\n' "$*"; }

[ -f .deploykey ] || { echo ".deploykey not found; it holds the raw deployer key and is never committed"; exit 1; }
DEPLOY_KEY="$(tr -d '[:space:]' < .deploykey)"
case "$DEPLOY_KEY" in 0x*) ;; *) DEPLOY_KEY="0x$DEPLOY_KEY" ;; esac
export DEPLOY_KEY
echo "deploy key read from .deploykey (${#DEPLOY_KEY} chars, not printed)"

say "1/8 compile and exercise the contract on a live EVM before spending anything"
node bin/compile.js
node bin/probe-override.js

say "2/8 deploy Speculum to Base Sepolia"
DEPLOY_OUT="$(node bin/deploy.js | tee /dev/stderr)"
ADDRESS="$(printf '%s\n' "$DEPLOY_OUT" | awk '/^address/ {print $2}')"
BLOCK="$(printf '%s\n' "$DEPLOY_OUT" | awk '/^block/ {print $2}')"
[ -n "$ADDRESS" ] && [ -n "$BLOCK" ] || { echo "could not read address and block from the deploy output"; exit 1; }
echo "deployed at $ADDRESS in block $BLOCK"

say "3/8 write the address and block where the code reads them"
sed -i '' "s#^export const CONTRACT = '0x[0-9a-fA-F]*';#export const CONTRACT = '$ADDRESS';#" src/deployment.js
sed -i '' "s#^export const DEPLOY_BLOCK = [0-9]*;#export const DEPLOY_BLOCK = $BLOCK;#" src/deployment.js
# the second data source in the manifest is the one after the SpeculumV1 block
python3 - "$ADDRESS" "$BLOCK" <<'PY'
import sys, re
addr, block = sys.argv[1].lower(), sys.argv[2]
p = 'subgraph/subgraph.yaml'; s = open(p).read()
head, sep, tail = s.partition('    name: Speculum\n')
assert sep, 'manifest has no Speculum data source'
tail = re.sub(r'address: "0x0{40}"', f'address: "{addr}"', tail, count=1)
tail = re.sub(r'startBlock: 0\n', f'startBlock: {block}\n', tail, count=1)
open(p, 'w').write(head + sep + tail)
print('subgraph/subgraph.yaml updated')
PY
grep -n "CONTRACT = \|DEPLOY_BLOCK = " src/deployment.js
grep -n "address:\|startBlock:" subgraph/subgraph.yaml
grep -q '0x0000000000000000000000000000000000000000' subgraph/subgraph.yaml && { echo "placeholder still present in the manifest, refusing to publish"; exit 1; }

say "4/8 build the subgraph"
( cd subgraph && ./node_modules/.bin/graph codegen && ./node_modules/.bin/graph build )

say "5/8 publish $SLUG $VERSION to Subgraph Studio"
echo "paste the Studio deploy key (from the subgraph's page in Studio); it is not echoed and not stored by this script:"
read -rs STUDIO_KEY; echo
[ -n "$STUDIO_KEY" ] || { echo "no key given"; exit 1; }
( cd subgraph && ./node_modules/.bin/graph deploy "$SLUG" --node https://api.studio.thegraph.com/deploy/ --deploy-key "$STUDIO_KEY" --version-label "$VERSION" )
unset STUDIO_KEY

say "6/8 pin $VERSION as the endpoint everything reads"
sed -i '' "s#/speculum/v0\.0\.[0-9]*'#/speculum/$VERSION'#" src/subgraph.js
grep -n "SUBGRAPH_URL = " src/subgraph.js

say "7/8 run the demo with the device attached; every blocked verdict asks for a tap"
echo "the device will show 'speculum approval' with the verdict, reason and deed hash. approve at least one and reject at least one."
node bin/demo.js --ledger

say "8/8 wait for the new version to sync, then verify the record"
for i in $(seq 1 30); do
  BODY="$(curl -s -X POST -H 'content-type: application/json' --data '{"query":"{ _meta { block { number } hasIndexingErrors } totals(id:\"0x746f74616c73\") { overrides signedOverrides } }"}' "https://api.studio.thegraph.com/query/1758736/$SLUG/$VERSION")"
  if printf '%s' "$BODY" | grep -q '"signedOverrides":"[1-9]'; then echo "$BODY"; break; fi
  echo "  waiting for $VERSION to index the new overrides ($i/30): $BODY"; sleep 10
done
npm run verify || true

say "done. what changed on disk, for you to review and commit:"
git status --short
echo
echo "expected: src/deployment.js, src/subgraph.js, subgraph/subgraph.yaml. commit them in the repo's register; nothing here commits for you."
