# Harness

An unattended run of every `agent-ready` issue in this repository: in dependency order, merged as it goes, with review checkpoints, a final benchmark and a report in Journal. Start it and leave it, for a weekend if needed.

## Start

From a Claude Code session in this checkout (on `main`, clean):

```
/harness            # the real run
/harness --dry      # only selects and prints what would run (one cheap agent)
```

Watch it with `/workflows`. You don't need to answer anything: there are no owner gates inside the run. Anything that needs you stops that issue, not the run.

## Machines

| Machine | Role | How agents use it |
|---|---|---|
| G14 (CachyOS) | runs the harness; lane 1 builds and tests here | `~/.claude/bin/heavy <cmd>` |
| yantra-box mini PC (Debian 13, Node 24) | lane 2 builds and tests here; the self-hosted CI runner (`actions-runner` user service) | `scripts/harness/remote.sh box <cmd>` |
| MacBook Pro (macOS 27, Xcode 27.2) | real WebKit, WKWebView, iOS simulator, paired iPhone 15 and iPad Air | `scripts/harness/webkit.sh <cmd>` (Mac first, podman fallback), `remote.sh mac <cmd>` |
| Redmi | Android Chrome for device benchmarks | `adb` on the G14, after Wireless debugging pairing |

`remote.sh` syncs the worktree, installs dependencies once per lockfile on that machine, runs under that machine's heavy lock and copies `test-results/`, `spike/results/` and `bench/results/` back. Exit 4 = unreachable.

## What one wave does

```
Select (Haiku)       git ff main · npm ci only if the lockfile changed · select.mjs --all
  └─ per ready issue, 2 lanes (lane 1 tests on the G14, lane 2 on the mini PC):
     Implement       own worktree · Model/Effort from the issue Metadata · self-verifies
     Simplify        Sonnet · only for non-S or big diffs
     Review ∥ Verify  Review: Opus (or Fable: issue `Review: fable`) · Verify: Sonnet, fresh context
     Fix ×2          round 1 same model · round 2 one tier up (Sonnet → Opus → Fable)
     Merge (Haiku)   PR + merge on a local pass · STOP comment + `blocked` label otherwise
Checkpoint           every 3 merges and before the end: /code-review high + /simplify over the range,
                     main's CI read once, fixes go through Verify and Merge like an issue
End                  Bench on main (Node, Chromium, Firefox, WebKit in a container) → Report (docs/report + Journal note)
```

The loop ends when nothing is ready: everything done, or the rest blocked or waiting on the owner.

## Why it is built this way

- **Never waits on CI.** Local verification is the merge gate. CI runs on its own, and checkpoints read main's result once. No polling: no idle agents, no wake-ups re-reading context, nothing that outlives a prompt-cache window.
- **No apt anywhere.** WebKit doesn't run on the Arch host, so `scripts/harness/webkit.sh` runs it in Playwright's container image through podman. CI's browser jobs use the same image. npm installs happen only when `package-lock.json` changes; worktrees symlink the main checkout's `node_modules`.
- **Lean context.** Each stage is a fresh agent with a short prompt. Logs go to `/tmp/pc-*.log` and only their tails are read. Summaries are capped at 150 words.
- **Adaptive models.** Haiku for mechanical stages, Sonnet for verify and simplify, Opus for implementation and review, Fable for the hardest reviews (`Review: fable`) and as the last escalation step.
- **Machine-safe.** Every heavy command goes through `~/.claude/bin/heavy` (one at a time on this 16 GB machine), with at most 2 issues in flight.
- **Behaviour.** CLAUDE.md: think first, simplest code, surgical changes, verify against the issue's criteria.

## Stopping, resuming, re-running

- **Stop:** cancel it in `/workflows`. Worktrees and pushed branches stay; a re-run continues them, because implementers reuse an existing branch.
- **Resume after a crash:** `Workflow({ scriptPath: ".claude/workflows/cipher-harness.js", resumeFromRunId: "<run id>", args: <same args> })`. Completed agents replay from cache.
- **A blocked issue:** read its last comment, fix the issue body or answer it, remove the `blocked` label, then `/harness` again.
- **PRs labelled `needs-owner`:** they have device-only checks. Merge them yourself after checking, then `/harness` again.

## Issue format

Context, Change, Verification (commands in backticks), STOP, and Metadata with:

```
Depends on: none | #n, #m
Size: S | M | L
Model: haiku | sonnet | opus | fable     (default: Sonnet for S, else Opus)
Effort: low | medium | high | xhigh | max  (default from Size)
Review: sonnet | opus | fable              (default Opus)
```

`node scripts/harness/select.mjs --all` lists what is ready and why the rest isn't; `node --test scripts/harness/select.test.mjs` tests the parser.
