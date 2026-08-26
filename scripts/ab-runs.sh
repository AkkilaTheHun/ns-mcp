#!/usr/bin/env bash
# ab-runs — score a config over several runs.
#
# The pipeline is nondeterministic: the same config scored 91.7% and 83.3% on
# consecutive runs of the same shoot. A single run therefore cannot tell a real
# 8-point regression from noise, and two of today's conclusions were drawn from
# exactly one sample each.
#
#   scripts/ab-runs.sh <Swatcher> <runs> [label]
#
# Env flags are passed through, so a config is expressed as:
#   NO_CLEAR_BASE_NOTE=1 scripts/ab-runs.sh Serpentine13 3 "no-clear-base"
set -uo pipefail
cd "$(dirname "$0")/.."

SWATCHER="${1:?usage: ab-runs.sh <Swatcher> <runs> [label]}"
RUNS="${2:-3}"
LABEL="${3:-default}"

scores=()
for i in $(seq 1 "$RUNS"); do
  NO_CORRECTIONS=1 pnpm tsx scripts/assign-swatcher.ts "/Halloween 2026/$SWATCHER" >"/tmp/ab-$LABEL-$i.log" 2>&1
  pct=$(pnpm tsx scripts/truth.ts score "$SWATCHER" 2>/dev/null | grep -oE '[0-9]+\.[0-9]+%' | tail -1 | tr -d '%')
  scores+=("$pct")
  echo "  $LABEL run $i: ${pct}%"
done

printf '%s\n' "${scores[@]}" | awk -v l="$LABEL" '
  {s+=$1; v[NR]=$1; if(NR==1||$1<mn)mn=$1; if(NR==1||$1>mx)mx=$1}
  END{printf "%s: mean %.1f%%  min %.1f%%  max %.1f%%  over %d run(s)\n", l, s/NR, mn, mx, NR}'
