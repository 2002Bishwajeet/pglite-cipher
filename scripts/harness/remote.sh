#!/bin/bash
# Usage: scripts/harness/remote.sh <mac|box> <command...>
# Runs a command from this worktree on another machine of the owner's tailnet:
#   mac = MacBook Pro (real WebKit/Safari, WKWebView, iOS simulator, paired iPhone and iPad)
#   box = yantra-box mini PC (Debian; a second machine for heavy Linux work)
# Syncs the worktree (without node_modules/.git), installs dependencies once per lockfile on that
# host (cached), runs the command under the host's heavy lock, then copies results back
# (test-results/, spike/results/, bench/results/). Exit 4 = host unreachable; otherwise the command's exit.
set -u
case "$1" in
  mac) host=bishwajeets-macbook-pro; sh='zsh -lc' ;;
  box) host=yantra-box; sh='bash -lc' ;;
  *) echo "usage: remote.sh <mac|box> <command...>" >&2; exit 2 ;;
esac
shift
ssh -o BatchMode=yes -o ConnectTimeout=10 "$host" true 2>/dev/null || { echo "[remote] $host unreachable" >&2; exit 4; }
name=$(basename "$PWD")
dir="pc-remote/$name"
ssh -o BatchMode=yes "$host" "mkdir -p $dir pc-remote/.nm"
rsync -a --delete --exclude node_modules --exclude .git --exclude test-results --exclude dist ./ "$host:$dir/"
q=$(printf '%q ' "$@")
if [ -f package-lock.json ]; then
  lock=$(sha256sum package-lock.json | cut -c1-16)
  prep="nm=\$HOME/pc-remote/.nm/$lock; if [ ! -d \$nm/node_modules ]; then mkdir -p \$nm && cp package.json package-lock.json \$nm/ && (cd \$nm && ~/.claude/bin/heavy npm ci --no-audit --no-fund >/tmp/pc-remote-npm.log 2>&1) || { tail -20 /tmp/pc-remote-npm.log; exit 1; }; fi; ln -sfn \$nm/node_modules node_modules;"
else
  prep=""
fi
# Without a tty the remote command survives a dropped ssh and sits in the heavy-lock queue for hours
# (seen 2026-11-16: 14 orphans on yantra-box). A watchdog ends it once the sshd session (\$PPID) is gone.
run="pp=\$PPID; S=\$(command -v setsid); \$S ~/.claude/bin/heavy $q & p=\$!; (while kill -0 \$p 2>/dev/null; do kill -0 \$pp 2>/dev/null || { [ -n \"\$S\" ] && kill -TERM -- -\$p; pkill -TERM -P \$p; kill \$p; exit; }; sleep 5; done) >/dev/null 2>&1 & wait \$p"
ssh -o BatchMode=yes "$host" "$sh $(printf '%q' "cd $dir && $prep $run")"
code=$?
for d in test-results spike/results bench/results; do
  ssh -o BatchMode=yes "$host" "test -d $dir/$d" 2>/dev/null && mkdir -p "$d" && rsync -a "$host:$dir/$d/" "$d/"
done
exit $code
