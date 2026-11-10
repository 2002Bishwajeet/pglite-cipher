#!/bin/bash
# Usage: scripts/harness/webkit.sh <command...>   e.g. scripts/harness/webkit.sh npm run test:browser -- --project webkit
# Playwright's WebKit doesn't run on this Arch host. Order of preference:
#   1. the Mac (real WebKit on macOS, through remote.sh; installs the webkit browser on first use);
#   2. the official Playwright container image through podman (Linux WebKit, no apt).
# Exit 3 = WebKit not runnable anywhere (CI covers it); any other exit is the command's.
set -u
here=$(cd "$(dirname "$0")" && pwd)
"$here/remote.sh" mac sh -c 'npx playwright install webkit >/tmp/pc-pw-webkit.log 2>&1 || { tail -5 /tmp/pc-pw-webkit.log; exit 1; }; exec "$@"' _ "$@"
code=$?
[ $code -ne 4 ] && exit $code
echo "[webkit] Mac unreachable; trying the Playwright container" >&2
ver=$(node -p "require('playwright/package.json').version" 2>/dev/null) || { echo "[webkit] playwright not installed" >&2; exit 3; }
command -v podman >/dev/null || { echo "[webkit] podman missing; CI covers WebKit" >&2; exit 3; }
img="mcr.microsoft.com/playwright:v${ver}-noble"
podman image exists "$img" || podman pull -q "$img" >/dev/null || { echo "[webkit] cannot pull $img; CI covers WebKit" >&2; exit 3; }
# The main checkout (parent of the shared .git) holds node_modules; harness worktrees live inside it.
root=$(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && pwd)
exec podman run --rm --ipc=host --userns=keep-id -e CI=1 -v "$root:$root:Z" -w "$PWD" "$img" "$@"
