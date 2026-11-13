#!/bin/bash
# Throwaway spike code (issue #11): runs the bench page in Chrome on the Redmi from the G14, with the
# collector here and `adb reverse` so the phone opens http://localhost (a secure context).
# Usage: ~/.claude/bin/heavy bash bench/device/redmi.sh [parts] [runs]   (after npm run bench:build)
# Exit 5 = no device attached (record it owner-pending); otherwise serve.mjs's exit.
set -u
adb=${ADB:-$HOME/.local/bin/adb}
parts=${1:-gates10,gates100,extras} runs=${2:-3}
port=47901
if ! "$adb" devices | grep -qP '\tdevice$'; then
  echo "[device] redmi: adb shows no device" >&2
  exit 5
fi
node bench/device/serve.mjs --port "$port" --until redmi &
srv=$!
trap 'kill $srv 2>/dev/null; "$adb" reverse --remove tcp:$port >/dev/null 2>&1' EXIT
sleep 1
"$adb" reverse "tcp:$port" "tcp:$port" || exit 1
"$adb" shell am start -a android.intent.action.VIEW -d "'http://localhost:$port/?auto=1&parts=$parts&runs=$runs&post=redmi'" com.android.chrome || exit 1
wait "$srv"
