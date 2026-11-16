#!/bin/bash
# #76 Redmi sequence: baseline, pack (pack.patch) N=8/4, workers (workers.patch) W=4/2, opfsread.
# Run on the Mac: scripts/harness/remote.sh mac bash bench/device/redmi-76.sh [runs]
set -u
runs=${1:-5}
one() { echo "== $1 $(date +%H:%M)"; TARGET=$1 QUERY=$2 bash bench/device/redmi.sh "$3" "$4"; echo "== $1 exit=$?"; }
one redmi-76-base '' gates100 "$runs"
git apply bench/patches/pack.patch || exit 1
one redmi-76-pack8 '&pack=8' gates100 "$runs"
one redmi-76-pack4 '&pack=4' gates100 "$runs"
git apply -R bench/patches/pack.patch
git apply bench/patches/workers.patch || exit 1
one redmi-76-workers4 '&workers=4' gates100 "$runs"
one redmi-76-workers2 '&workers=2' gates100 "$runs"
git apply -R bench/patches/workers.patch
one redmi-76-opfsread '' opfsread 1
