---
description: Hourly check-in on the cipher-harness run; detect stuck, fix the harness, relaunch
---
You are the hourly check-in for the unattended pglite-cipher harness (repo 2002Bishwajeet/pglite-cipher, checkout /home/biswa/Github/pglite-cipher). The owner is asleep and wants the harness to keep making progress until the library is usable. Be cheap: read state, act only if needed, reply in ≤80 words.

1. Look (lean; logs only via `tail`):
   - The cipher-harness workflow run state (is a run active? its last log lines / phase).
   - `node scripts/harness/select.mjs --all`
   - `gh pr list -R 2002Bishwajeet/pglite-cipher --state open --json number,title,labels,updatedAt`
   - `gh issue list -R 2002Bishwajeet/pglite-cipher -l blocked -l ci-failure --state open` (each label separately) and the last comment of each blocked issue.
   - `git -C /home/biswa/Github/pglite-cipher log origin/main -1 --format='%h %cr %s'` after `git fetch -q`.
   - Newest mtime of `/tmp/pc-*.log`; age of any heavy lock (`ls -l --time-style=+%s` on the lock `~/.claude/bin/heavy` uses).
   - `gh run list -R 2002Bishwajeet/pglite-cipher --branch main --limit 3` (read once, never wait).
   - CI health: `gh run list -R 2002Bishwajeet/pglite-cipher --limit 20 --json databaseId,status,createdAt,updatedAt` (runs `queued` or `in_progress` for 2+ hours), and `gh api repos/2002Bishwajeet/pglite-cipher/actions/runners --jq '.runners[]|{name,status,busy}'`. Docs-only pushes (`docs/**`) get no run by design.

2. Stuck means any of:
   - No run active, yet issues are ready (or a ready ci-failure issue exists).
   - Run active but no merge, no new branch commit and no `/tmp/pc-*.log` write for 60+ minutes.
   - An open `agent-harness` PR with no agent working on it (merge it if its body shows passing checks; otherwise leave it).
   - A `blocked` issue whose last comment says an agent "died" or "after escalation" from an infra cause: remove the label once (and say so in a comment).
   - A heavy lock held 15+ minutes by a process that no longer exists.
   - Main CI red with no open ci-failure issue (the next select creates one; if no run is active, relaunch).
   - CI stuck: a run queued/in_progress 2+ hours, or the yantra-box runner offline.
   - Owner-gated: a `blocked` issue (or a `Go: no` / decision request) waiting on the owner.

3. Fix and proceed:
   - If the cause is a harness bug (`.claude/workflows/cipher-harness.js`, `scripts/harness/*`), fix it minimally, `node --check` it (wrap in an async function: top-level return), and note the change in your reply.
   - A stuck active run: stop it (TaskStop), then relaunch.
   - Relaunch FRESH (never resumeFromRunId; cached results replay the same ending): Workflow with scriptPath `.claude/workflows/cipher-harness.js` and args `{ "repoRoot": "/home/biswa/Github/pglite-cipher", "date": "<today YYYY-MM-DD>", "maxWaves": 30 }`. The checkout must be on `main` and clean outside `.claude/`; if it isn't, inspect and restore it (never discard someone's commits; never push to main).
   - CI stuck: `gh run cancel <id>`, then `gh api -X POST .../actions/runs/<id>/force-cancel`. If both refuse with "not been queued yet" and the run has 0 jobs, it is a GitHub ghost (cannot be cancelled or deleted, harmless): list it once in your reply as ignored and never retry it. Ghosts known on 2026-11-12: 43095867405, 43095856950. If the runner is offline, or busy with a run stuck 2+ hours: `ssh -o BatchMode=yes yantra-box 'systemctl --user restart actions-runner'`, then re-read the runner status once. Never wait for the rerun.
   - Owner-gated decision (design/format/go-no-go): the first time you see it, send a PushNotification (one line, <200 chars, issue number plus the question) and post nothing. At the next check-in, if the owner still has not commented after the notification, spawn an Agent with model `fable` and effort `high`. Give it the issue body, the agent's blocking comment, the plan sections it cites and the relevant measurements. Ask for a decision with conditions in ≤300 words. Post that decision as an issue comment ("Decision (Fable review, owner unavailable): …"), remove `blocked`, and relaunch if no run is active.
   - Physical devices (iPhone 15, iPad Air, Redmi, or anything an agent can't reach, e.g. in #11): never decide or substitute. Agents run what they can reach (macOS WebKit/WKWebView, iOS simulator via the Mac) and must not hold up the rest. Detect it from an issue comment, PR body or `spike/RESULTS.md` listing `owner-pending`, or #11 becoming active. Send a PushNotification naming the device runs needed (`device runs needed for #<n>: <devices>; reply in session`), at most once per issue, then carry on. If the owner later supplies numbers, record them on the issue.
   - Everything done (no open agent-ready issues): do nothing, and say so.

4. Never: wait on CI, sleep-poll, weaken a test, push to main, or merge a PR whose verification failed. If nothing is wrong, reply "healthy: <one-line state>".
