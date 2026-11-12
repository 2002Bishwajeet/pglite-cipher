#!/bin/bash
# Throwaway spike code (issue #11): runs the bench page on one Apple target and saves what it posts
# to spike/results/<target>.json. From the Linux host:
#   scripts/harness/remote.sh mac bash spike/device/mac.sh <target> [parts] [runs]
# Targets: mac-webkit (Playwright WebKit), mac-wkwebview (spike/device/wkhost.swift), ios-sim (Mobile
# Safari in a simulator it boots and shuts down), iphone-15, ipad-air-m3 (Safari on the paired device,
# over HTTPS through `tailscale serve` on the bench port only, turned off again on exit).
# Exit 5 = the device is not available (record it owner-pending); otherwise serve.mjs's exit.
set -u
target=$1 parts=${2:-gates10,gates100,extras} runs=${3:-3}
port=47901
q="?auto=1&parts=$parts&runs=$runs&post=$target"

udid=''
case $target in
  mac-webkit | mac-wkwebview) ;;
  ios-sim) udid=$(xcrun simctl list devices available | sed -nE 's/^ *iPhone 17e \(([0-9A-F-]+)\).*/\1/p' | head -1) ;;
  iphone-15 | ipad-air-m3)
    model='iPhone 15 ('
    [ "$target" = ipad-air-m3 ] && model='iPad Air 11-inch (M3)'
    row=$(xcrun devicectl list devices 2>/dev/null | grep -F "$model" | grep -F physical)
    udid=$(sed -nE 's/.* ([0-9A-F-]+) \(UDID\).*/\1/p' <<<"$row")
    if [ -z "$udid" ] || ! grep -qF 'available' <<<"$row" || grep -qF 'unavailable' <<<"$row"; then
      echo "[device] $target is not available: ${row:-not listed}" >&2
      exit 5
    fi
    ;;
  *) echo "usage: mac.sh <mac-webkit|mac-wkwebview|ios-sim|iphone-15|ipad-air-m3> [parts] [runs]" >&2; exit 2 ;;
esac

[ -f bench/dist/index.html ] || npm run bench:build >/tmp/pc-device-build.log 2>&1 || { tail -20 /tmp/pc-device-build.log; exit 1; }
node spike/device/serve.mjs --port "$port" --until "$target" &
srv=$!
booted='' ts=''
cleanup() {
  kill "$srv" 2>/dev/null
  [ -n "$ts" ] && tailscale serve --https="$port" off >/dev/null 2>&1
  [ -n "$booted" ] && xcrun simctl shutdown "$udid" 2>/dev/null
}
trap cleanup EXIT
sleep 1

case $target in
  mac-webkit)
    npx playwright install webkit >/tmp/pc-pw-webkit.log 2>&1 || { tail -5 /tmp/pc-pw-webkit.log; exit 1; }
    node spike/device/pw.mjs "http://localhost:$port/$q" || exit 1
    ;;
  mac-wkwebview) swift spike/device/wkhost.swift "http://localhost:$port/$q" || exit 1 ;;
  ios-sim)
    if ! xcrun simctl list devices booted | grep -qF "$udid"; then xcrun simctl boot "$udid" && booted=1; fi
    xcrun simctl bootstatus "$udid" -b >/dev/null
    [ -n "$booted" ] && sleep 20
    # Right after a boot, openurl fails ("Couldn't communicate with a helper application") for a while.
    for i in 1 2 3 4 5 6 7; do
      xcrun simctl openurl "$udid" "http://localhost:$port/$q" 2>/dev/null && break
      [ "$i" = 7 ] && exit 1
      sleep 10
    done
    ;;
  iphone-15 | ipad-air-m3)
    ts=1
    tailscale serve --bg --https="$port" "http://127.0.0.1:$port" >/dev/null
    host=$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')
    url="https://$host:$port/$q"
    echo "[device] $url"
    xcrun devicectl device process launch --device "$udid" --payload-url "$url" com.apple.mobilesafari ||
      echo "[device] could not launch Safari; open $url on the device (still waiting)"
    ;;
esac
wait "$srv"
