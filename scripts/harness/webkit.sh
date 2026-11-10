#!/bin/bash
# Usage: scripts/harness/webkit.sh <command...>   e.g. scripts/harness/webkit.sh npm run test:browser -- --project webkit
# Playwright's WebKit does not run on this Arch host, so WebKit runs inside the official Playwright image
# (Ubuntu with every browser dependency: no apt, no browser download). The image tag follows the
# installed playwright version. Mounts the main checkout, which contains the harness worktrees and the
# node_modules they symlink. Exit 3 = WebKit not runnable here (CI covers it); any other exit is the command's.
set -u
ver=$(node -p "require('playwright/package.json').version" 2>/dev/null) || { echo "[webkit] playwright not installed" >&2; exit 3; }
command -v podman >/dev/null || { echo "[webkit] podman missing; CI covers WebKit" >&2; exit 3; }
img="mcr.microsoft.com/playwright:v${ver}-noble"
podman image exists "$img" || podman pull -q "$img" >/dev/null || { echo "[webkit] cannot pull $img; CI covers WebKit" >&2; exit 3; }
# The main checkout (parent of the shared .git) holds node_modules; harness worktrees live inside it.
root=$(cd "$(git rev-parse --path-format=absolute --git-common-dir)/.." && pwd)
exec podman run --rm --ipc=host --userns=keep-id -e CI=1 -v "$root:$root:Z" -w "$PWD" "$img" "$@"
