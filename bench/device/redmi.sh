#!/bin/bash
# Throwaway spike code (issue #11): runs the bench page in Chrome on the Redmi, with the collector
# here and `adb reverse` so the phone opens http://localhost (a secure context). The Redmi is attached
# to the Mac: scripts/harness/remote.sh mac bash bench/device/redmi.sh [parts] [runs] [block]
# (block: the gates' encrypted block size, e.g. 262144 (#63); default the codec's 65536)
# QUERY (e.g. '&pack=8', '&workers=4') is appended to the page URL; TARGET (default redmi) names the
# result, saved as bench/results/<TARGET>.json.
# (it rebuilds bench/dist first; adb from $ADB, else ~/.local/bin/adb, else PATH).
# Exit 5 = no device attached (record it owner-pending); otherwise serve.mjs's exit.
set -u
if [ -n "${ADB:-}" ]; then adb=$ADB
elif [ -x "$HOME/.local/bin/adb" ]; then adb=$HOME/.local/bin/adb
else adb=adb; fi
parts=${1:-gates10,gates100,extras} runs=${2:-3} block=${3:+&block=$3}
port=47901 target=${TARGET:-redmi} query=${QUERY:-}
if ! "$adb" devices | awk '$2=="device"{f=1} END{exit !f}'; then
  echo "[device] redmi: adb shows no device" >&2
  exit 5
fi
# Always rebuild: remote.sh's rsync excludes dist, so a build left by an earlier run would go stale.
npm run bench:build >/tmp/pc-device-build.log 2>&1 || { tail -20 /tmp/pc-device-build.log; exit 1; }
node bench/device/serve.mjs --port "$port" --until "$target" &
srv=$!
trap 'kill $srv 2>/dev/null; "$adb" reverse --remove tcp:$port >/dev/null 2>&1' EXIT
sleep 1
"$adb" reverse "tcp:$port" "tcp:$port" || exit 1
"$adb" shell am start -a android.intent.action.VIEW -d "'http://localhost:$port/?auto=1&parts=$parts&runs=$runs$block$query&post=$target'" com.android.chrome || exit 1
wait "$srv"
