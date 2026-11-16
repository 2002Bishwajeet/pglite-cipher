export const meta = {
  name: 'cipher-harness',
  description: 'Unattended run of pglite-cipher agent-ready issues: waves of implement → simplify → review + verify → merge, checkpoints, benchmarks, Journal report',
  whenToUse: 'Launch from a session in the pglite-cipher checkout; args = { repoRoot, date: "YYYY-MM-DD", maxWaves?, dryRun? }. See docs/HARNESS.md',
  phases: [
    { title: 'Select', detail: 'sync main, install if the lockfile changed, pick ready issues', model: 'haiku' },
    { title: 'Implement', detail: 'one worktree per issue, model and effort from the issue Metadata, self-verifies' },
    { title: 'Simplify', detail: 'trim over-engineering in the diff (non-S or big diffs)', model: 'sonnet' },
    { title: 'Review', detail: 'adversarial correctness + security review, read-only; Opus or Fable by issue' },
    { title: 'Verify', detail: 'fresh-context run of the issue Verification commands', model: 'sonnet' },
    { title: 'Merge', detail: 'PR + merge on a local pass, STOP comment otherwise; never waits on CI', model: 'haiku' },
    { title: 'Checkpoint', detail: 'every 3 merges and at the end: /code-review + /simplify over the range, main CI read once' },
    { title: 'Bench', detail: 'final benchmark run on main, results committed' },
    { title: 'Report', detail: 'final report in docs/report and in Journal (Project Reports)' },
  ],
}

const REPO = '2002Bishwajeet/pglite-cipher'
const { repoRoot, date, maxWaves = 30, dryRun = false } = args || {}
if (!repoRoot || !date) throw new Error('args.repoRoot and args.date (YYYY-MM-DD) are required')

const LANES = 2              // 16 GB machine; heavy commands are serialised by ~/.claude/bin/heavy anyway
const CHECKPOINT_EVERY = 4   // merges between checkpoints
const MAX_FIX_ROUNDS = 2     // round 1 same model, round 2 one tier up (see LADDER)
const EFFORT = { S: 'medium', M: 'high', L: 'xhigh' }
const LADDER = { haiku: 'sonnet', sonnet: 'opus', opus: 'opus', fable: 'fable' } // Fable only when the issue asks for it
const MAX_INFRA_RETRIES = 2  // agent deaths (quota, crash) are retried, never labelled blocked
const LADDER_EFFORT = { sonnet: 'high', opus: 'xhigh', fable: 'high' }
const JOURNAL_FOLDER = 'cad34671-f51d-c7e9-2f88-4698cfe4190d' // Journal "Project Reports"

// ---------- schemas ----------
const SELECT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', description: 'false if the checkout was dirty or not on main' },
    problem: { type: 'string' },
    mainSha: { type: 'string' },
    ciFailureIssue: { type: 'number', description: 'number of the open ci-failure issue, 0 if none' },
    ciState: { type: 'string', description: 'main CI: sha, workflow, conclusion of the newest completed run' },
    ready: { type: 'array', items: { type: 'object', properties: {
      number: { type: 'number' }, title: { type: 'string' }, size: { type: 'string' },
      model: { type: 'string' }, effort: { type: 'string' }, review: { type: 'string' },
    }, required: ['number', 'title'] } },
    skipped: { type: 'array', items: { type: 'object', properties: {
      number: { type: 'number' }, title: { type: 'string' }, reason: { type: 'string' },
    }, required: ['number', 'reason'] } },
  },
  required: ['ok', 'mainSha', 'ready', 'skipped'],
}

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['done', 'stopped'] },
    worktreePath: { type: 'string', description: 'absolute path of the worktree (pwd)' },
    branch: { type: 'string' },
    summary: { type: 'string', description: '≤150 words: what changed and why' },
    changedFiles: { type: 'array', items: { type: 'string' } },
    linesChanged: { type: 'number', description: 'insertions + deletions, git diff --shortstat origin/main...HEAD' },
    selfCheck: { type: 'string', description: 'Verification commands you ran and their exit codes, one per line' },
    condition: { type: 'string', description: 'the STOP condition that matched, if stopped' },
    details: { type: 'string' },
  },
  required: ['status', 'worktreePath', 'branch', 'summary', 'changedFiles'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: {
      severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
      file: { type: 'string' }, line: { type: 'number' },
      problem: { type: 'string' }, fix: { type: 'string' },
    }, required: ['severity', 'problem', 'fix'] } },
    summary: { type: 'string', description: '≤80 words' },
  },
  required: ['findings', 'summary'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    checks: { type: 'array', items: { type: 'object', properties: {
      command: { type: 'string' },
      exitCode: { type: 'string', description: 'number, or "owner-run" / "ci-covers" (webkit.sh exit 3)' },
      tail: { type: 'string', description: 'last 8 lines' },
    }, required: ['command', 'exitCode', 'tail'] } },
    problems: { type: 'array', items: { type: 'string' } },
    ownerOnly: { type: 'array', items: { type: 'string' }, description: 'acceptance items only the owner can do (real devices)' },
  },
  required: ['verdict', 'checks', 'problems'],
}

const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    result: { type: 'string', description: 'merged <PR url> | closed (no code) | open: needs owner <PR url> | stopped: <reason>' },
    merged: { type: 'boolean' },
  },
  required: ['result', 'merged'],
}

const BENCH_SCHEMA = {
  type: 'object',
  properties: {
    ran: { type: 'boolean' },
    resultsDir: { type: 'string' },
    gates: { type: 'array', items: { type: 'object', properties: {
      gate: { type: 'string' }, target: { type: 'string' }, value: { type: 'string' }, pass: { type: 'boolean' },
    }, required: ['gate', 'pass'] } },
    summary: { type: 'string' },
  },
  required: ['ran', 'summary'],
}

// ---------- shared prompt pieces ----------
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '')
const cdInto = (w) => `\`cd ${w.worktreePath}\` first (if it is gone: \`git -C ${repoRoot} worktree add ${w.worktreePath} ${w.branch}\`, then cd)`
const DEPS = `Dependencies: if \`package-lock.json\` exists and \`cmp -s package-lock.json ${repoRoot}/package-lock.json\` succeeds and ${repoRoot}/node_modules exists, \`ln -s ${repoRoot}/node_modules node_modules\`; otherwise run \`npm ci\` under heavy.`
const HEAVY_LOCAL = 'Heavy commands (npm ci, build, lint, test, test:browser, bench, node scripts that start PGlite, AND every targeted run: `npx vitest …` on one file or one project, `npx playwright …`, `vite build`, `tsc`): only as `~/.claude/bin/heavy <cmd> > /tmp/pc-<tag>-<step>.log 2>&1; echo exit=$?`, foreground, timeout 600000. No exceptions: three sessions share this 16 GB machine, and a browser test run outside the lock gets sessions OOM-killed. Read `tail -40` of the log; on failure add `grep -nE "FAIL|Error|✗|×" <log> | head -40`. WebKit runs only through `scripts/harness/webkit.sh <cmd>` (do NOT wrap it in heavy; it takes the right machine\'s lock itself); its exit 3 means "not runnable here, CI covers it". Where an issue says `npm run test:browser` for all engines, run it as `npm run test:browser -- --project chromium --project firefox` plus `scripts/harness/webkit.sh npm run test:browser -- --project webkit`.'
// Lane 2 runs its heavy commands on the yantra-box mini PC, so two issues can build and test at once.
const HEAVY_BOX = 'Heavy commands (npm ci, build, lint, test, test:browser, bench, node scripts that start PGlite): run them on the yantra-box mini PC as `scripts/harness/remote.sh box <cmd> > /tmp/pc-<tag>-<step>.log 2>&1; echo exit=$?` (it syncs this worktree, installs per lockfile there and takes that machine\'s heavy lock), foreground, timeout 600000; exit 4 means the box is unreachable: then use `~/.claude/bin/heavy <cmd>` locally. The box also runs CI and can be 10x slower: if a box command hits the 600 s timeout, rerun it locally with `~/.claude/bin/heavy <cmd>`, or split `npm test` by directory (`npx vitest run test/<dir>`, each its own log); never return with verification unfinished because of a timeout. Read `tail -40` of the log; on failure add `grep -nE "FAIL|Error|✗|×" <log> | head -40`. ' + HEAVY_LOCAL.slice(HEAVY_LOCAL.indexOf('WebKit runs only'))
const PUSH = (b) => `\`git push -u origin ${b}\`; if it is rejected as non-fast-forward and \`git cherry HEAD origin/${b}\` prints only \`-\` lines (the branch was rebased, nothing on origin is lost), \`git push -u --force-with-lease origin ${b}\``
const heavyFor = (host) => (host === 'box' ? HEAVY_BOX : HEAVY_LOCAL)
const NO_CI = 'Never wait on CI: no `gh pr checks`, no `gh run watch`, no sleep loops. CI runs the full suite on main by itself; a red main comes back to the harness as a `ci-failure` issue.'
const LOCAL_SCOPE = 'Test locally what you changed: targeted tests while you work (each one under heavy, as above), then the issue\'s Verification commands once. Where a Verification command runs `npm run test:browser` for all engines, run Chromium locally (or on the box) and record Firefox and WebKit as exitCode "ci-covers": the full cross-engine suite is CI\'s job.'

// ---------- stage prompts ----------
function selectPrompt() {
  return `Prepare the pglite-cipher checkout for the next harness wave and report which issues are ready. Do only this:
1. \`cd ${repoRoot}\`. If \`git status --porcelain\` shows anything outside \`.claude/\`, or the branch is not \`main\`, return ok=false with the output as problem.
2. \`git fetch -q origin && git merge --ff-only origin/main\`. mainSha = \`git rev-parse HEAD\`.
3. If \`package-lock.json\` exists and (\`node_modules\` is missing, or \`cmp -s package-lock.json node_modules/.package-lock.json\` fails): \`~/.claude/bin/heavy npm ci > /tmp/pc-select-ci.log 2>&1; echo exit=$?\`. If \`node_modules/playwright\` exists: \`npx playwright install chromium firefox > /tmp/pc-select-pw.log 2>&1\` (no --with-deps; WebKit runs in a container).
4. CI feedback (read once, never wait): \`gh run list -R ${REPO} --branch main --limit 5 --json headSha,status,conclusion,workflowName,databaseId\`. ciState = sha, workflow and conclusion of the newest completed run. If that conclusion is failure or timed_out, and \`gh issue list -R ${REPO} --label ci-failure --state open --json number\` is empty: \`gh label create ci-failure --color D93F0B -R ${REPO} 2>/dev/null || true\`, then \`gh run view <id> -R ${REPO} --log-failed | tail -80 > /tmp/pc-ci-fail.txt\` and create an issue (\`gh issue create -R ${REPO} --label agent-ready,ci-failure --title "CI red on main (<workflow>, <sha7>)" --body-file <file>\`) whose body has: \`## Context\` (run URL, sha, the failing job and the last 80 log lines in a fenced block), \`## Change\` (make the failing job pass without weakening any test; if the failure is infrastructure, e.g. runner offline or minutes exhausted, say so and stop), \`## Verification\` (the failing job's command in backticks), \`## STOP and comment on the issue if\` (the fix needs a test weakened, or it is infrastructure), and \`## Metadata\` with lines \`Depends on: none\`, \`Size: S\`, \`Model: sonnet\`, \`Effort: high\`. If the newest completed run succeeded and an open ci-failure issue exists whose sha is older, close that issue with a comment "CI green on <sha7>". ciFailureIssue = the open ci-failure issue number, else 0.
5. \`node scripts/harness/select.mjs --all --json\` and return its ready and skipped arrays verbatim (rows: number, title, size, model, effort, review, reason).
Return ok, mainSha, ciFailureIssue, ciState, ready, skipped.`
}

function implementPrompt(it) {
  return `You are implementing GitHub issue #${it.number} of ${REPO}: "${it.title}".
1. You are in a fresh git worktree. \`pwd\`, then: if branch \`${it.branch}\` exists (\`git rev-parse --verify -q ${it.branch}\` or on origin), check it out and continue from it; otherwise \`git checkout -b ${it.branch} origin/main\`. ${DEPS}
2. Read the issue once: \`gh issue view ${it.number} -R ${REPO} --comments\`. Read only the plan and research sections it cites, and the code you change. Follow it exactly, including its STOP conditions: if one applies, return status "stopped" with the condition and details. Do not improvise around it.
3. ${it.heavy} ${LOCAL_SCOPE}
4. Stay inside this worktree and the issue's scope. CLAUDE.md's rules apply (no test weakening, WebCrypto only, no secrets in logs).
5. Self-verify before returning: run every command in the issue's \`## Verification\` section and fix what fails. Put each command and its exit code in selfCheck.
6. Commit on the branch (conventional message referencing #${it.number}; no attribution lines). Do NOT push or open a PR. ${NO_CI}
If the issue needs no code (a decision or record issue), do what it says, including posting the issue comment it asks for yourself (\`gh issue comment ${it.number} -R ${REPO} --body-file <file>\`), but do NOT close the issue; make no commit, and return changedFiles [] with summary = what you posted.
Return the fields of the schema; summary ≤150 words.`
}

function simplifyPrompt(it, w) {
  return `You are the simplifier for ${it.tag} of ${REPO}, branch ${w.branch}. ${cdInto(w)}; work only there. Do NOT invoke skills or spawn subagents.
Read \`git diff origin/main...HEAD\`. Cut over-engineering in lines this branch added: unrequested options or abstractions, single-use helpers, re-implemented built-ins, defensive code for impossible cases, dead code, verbose comments. Keep behaviour, every test, validation and error handling on data-loss and crypto paths. Never touch tests' strength (iterations, cases, properties).
If you changed anything: ${it.heavy} Run build, lint and test (Node) that way; if one fails and you can't fix it quickly, \`git checkout -- .\`. Commit passing edits as \`refactor: simplify ${it.tag}\` (no attribution). Do not push.
Return the implementer schema (status "done", same worktreePath and branch) with summary = what you removed, or "nothing to simplify".`
}

function reviewPrompt(it, w) {
  return `You are an adversarial reviewer for ${it.tag} of ${REPO}, branch ${w.branch}. ${cdInto(w)}. READ-ONLY: never edit, commit or push. Don't run heavy commands; read code.
Read the issue with its comments (\`gh issue view ${it.number || ''} -R ${REPO} --comments\`${it.number ? '' : ' — skip, this is a checkpoint; review the range below'}); an owner decision in the body or comments approves exactly the test change it names, so that change is not a finding and \`git diff origin/main...HEAD\`. Find real defects only:
- correctness: off-by-one in block/offset math, truncate/extend, partial writes, state-machine holes, unhandled rejections, races between sync and write;
- security: nonce or IV reuse, AAD not binding store/file/position/version, key bytes extractable or logged, plaintext or keys in errors/logs, downgrade paths, comparisons that leak, randomness from anything but crypto.getRandomValues;
- tests weakened, skipped, \`.only\`, fewer iterations, or assertions that cannot fail;
- scope: files changed outside the issue.
For each finding give severity (blocker = data loss, crypto break or wrong result; major = likely bug or missing required test; minor = style or clarity), file, line, the problem and a concrete fix. Don't report taste. No findings is a valid answer.
Implementer summary: ${w.summary}`
}

function verifyPrompt(it, w) {
  return `You are the verifier for ${it.tag} of ${REPO}, branch ${w.branch}. ${cdInto(w)}; work only there. READ-ONLY on source: never edit, commit or push.
- ${it.number ? `Read the issue with its comments: \`gh issue view ${it.number} -R ${REPO} --comments\` (an owner decision there approves exactly the test change it names). Run every command in its \`## Verification\` section, in order. An item "the issue is closed" is done by the merge stage after you: ignore it.` : 'This is a checkpoint: run build, lint, test and test:browser (chromium).'} ${it.heavy} ${LOCAL_SCOPE}
- A WebKit run that exits 3 is exitCode "ci-covers", not a failure. Anything only the owner can do (real devices, Tauri webviews) goes in ownerOnly with exitCode "owner-run".
- Check that \`git diff origin/main...HEAD\` doesn't weaken tests (\`.skip\`, \`.only\`, \`todo\`, smaller fast-check numRuns, deleted assertions). Each one is a problem.
- verdict "pass" only if every command you ran exited 0 (or ci-covers or owner-run) and problems is empty. ${NO_CI}
Implementer self-check:
${w.selfCheck || '(none)'}`
}

function fixPrompt(it, w, problems) {
  return `You worked on ${it.tag} of ${REPO}, branch ${w.branch}. ${cdInto(w)}; work only there. ${DEPS}
Fix these problems found by the reviewer and verifier:
${problems.map((p) => `- ${p}`).join('\n')}
Stay in scope; never weaken a test to make it pass. Re-run the failing commands. ${it.heavy} ${LOCAL_SCOPE} Commit (no attribution). Do not push. ${NO_CI}
If a fix needs to leave the scope, or a STOP condition now applies, return status "stopped". Return the implementer schema; update selfCheck.`
}

function mergePrompt(it, w, verdict, review) {
  if (w.status === 'stopped') {
    return `Record a STOP for ${it.tag} of ${REPO}. Do exactly this:
1. \`gh label create blocked --color B60205 --description "Agent hit a STOP condition; see last comment" -R ${REPO} 2>/dev/null || true\`
2. ${it.number ? `\`gh issue comment ${it.number} -R ${REPO} --body-file <file>\`, the file saying: the harness stopped; condition "${w.condition || 'unspecified'}"; details ${JSON.stringify(w.details || w.summary)}; branch \`${w.branch}\`; last problems ${JSON.stringify(verdict?.problems || [])}. Then \`gh issue edit ${it.number} -R ${REPO} --add-label blocked\`.` : 'This is a checkpoint: skip the comment.'}
3. ${cdInto(w)}; if \`git log origin/main..HEAD --oneline\` is non-empty, ${PUSH(w.branch)}. Never push to main.
Return result "stopped: <condition>", merged false.`
  }
  if (!(w.changedFiles || []).length) {
    return `${it.tag} of ${REPO} needed no code and passed verification. Comment its outcome and close it: write ${JSON.stringify(w.summary)} to a file, \`gh issue comment ${it.number} -R ${REPO} --body-file <file>\`, then \`gh issue close ${it.number} -R ${REPO} --reason completed\`. Return result "closed (no code)", merged true.`
  }
  const owner = verdict.ownerOnly || []
  return `Publish ${it.tag} of ${REPO}. ${cdInto(w)}. Do exactly this:
1. \`gh label create agent-harness --color 5319E7 -R ${REPO} 2>/dev/null || true\`; ${PUSH(w.branch)} (never to main).
2. PR body in a file: ${it.number ? `first line \`Closes #${it.number}\`; ` : ''}\`## Summary\` (from the notes below, for a reviewer); a table \`command | exit\` from the checks; \`## Review\` with the reviewer's summary and any minor findings left; owner-only items as unchecked \`- [ ]\` boxes. No attribution lines.
3. \`gh pr create -R ${REPO} --base main --head ${w.branch} --label agent-harness --title ${JSON.stringify(it.number ? `${it.title} (#${it.number})` : it.title)} --body-file <file>\`
4. ${owner.length ? `It has owner-only items: they must not hold up later issues. Post them as unchecked boxes in a comment on issue #4 (\`gh issue comment 4 -R ${REPO} --body-file <file>\`, titled "Owner-only checks from ${it.tag} (<PR url>)"). Then continue: ` : ''}Merge it now: \`gh pr merge <n> -R ${REPO} --merge --delete-branch\`. The local verification is the gate; ${NO_CI} If it refuses because main moved and conflicts: \`git fetch origin && git rebase origin/main\`; if that is clean, \`~/.claude/bin/heavy npm test > /tmp/pc-${it.tag.replace('#', '')}-rebase.log 2>&1; echo exit=$?\`, and on exit 0 force-push the branch and merge; otherwise leave the PR open and return "open: conflict <url>". After merging, cancel this branch's now-useless CI runs so they don't block the single runner: \`for id in $(gh run list -R ${REPO} --branch <branch> --json databaseId,status -q '.[]|select(.status!="completed")|.databaseId'); do gh run cancel $id -R ${REPO}; done\`. ${it.number ? `After merging, check \`gh issue view ${it.number} -R ${REPO} --json state -q .state\`; if not CLOSED, close it with a comment linking the PR.` : ''}
5. Remove the worktree: \`git -C ${repoRoot} worktree remove --force ${w.worktreePath}\` (only after a merge).
Return result ("merged <url>" or as above) and merged.
Notes: ${JSON.stringify(w.summary)}
Checks: ${JSON.stringify((verdict.checks || []).map((c) => ({ command: c.command, exit: c.exitCode })))}
Review: ${JSON.stringify(review?.summary || '')}; minor findings: ${JSON.stringify((review?.findings || []).filter((f) => f.severity === 'minor').map((f) => f.problem))}
Owner-only: ${JSON.stringify(owner)}`
}

function checkpointPrompt(cp) {
  return `You run checkpoint ${cp.k} of the pglite-cipher harness: a review and simplification pass over everything merged since ${cp.base} (main is now ${cp.head}).
1. In this fresh worktree: \`git checkout -b ${cp.branch} origin/main\`. ${DEPS}
2. Commit nothing yet. Invoke the code-review skill (Skill tool, skill "code-review", args "medium") on the changes ${cp.base}..HEAD; if it needs a target, give it this branch and say the base is ${cp.base}. Then invoke the simplify skill (Skill tool, skill "simplify") on the same range. These skills may spawn reviewers that edit files: after each, run \`git status\` and \`git log origin/main..HEAD\`, keep only edits in this worktree, never anything pushed to main (if something was pushed elsewhere, report it in details).
3. Fix every confirmed blocker or major finding that's within what the merged issues asked for; list the rest in details. Never weaken a test.
4. (CI feedback is handled by the select stage; skip if a ci-failure issue is open.) Read main's CI once: \`gh run list -R ${REPO} --branch main --limit 3 --json headSha,conclusion,workflowName,databaseId\`. If the newest completed run failed, \`gh run view <id> -R ${REPO} --log-failed | tail -60\`, fix it here if it is a code or test problem, else note it (for example, minutes exhausted). ${NO_CI}
5. ${HEAVY_LOCAL} Run build, lint, test and test:browser (chromium) that way. Commit fixes as \`chore(checkpoint-${cp.k}): …\` (no attribution). Do not push.
Return the implementer schema: summary = findings fixed and left (≤150 words), changedFiles [] if nothing changed.`
}

function benchPrompt() {
  return `Run the final benchmark of pglite-cipher on main and commit the results.
1. In this fresh worktree: \`git checkout -b agent/bench-${date} origin/main\`. ${DEPS}
2. Read \`bench/README.md\` (or \`spike/README.md\` if bench/ doesn't exist; if neither exists return ran=false). Run the full benchmark it documents for Node, Chromium and Firefox, and WebKit through webkit.sh, at 10 MB and 100 MB. ${HEAVY_LOCAL}
3. Save the JSON under \`bench/results/${date}/\` and write \`bench/results/${date}/SUMMARY.md\` (it is a repo file the commit needs, not a report: if the Write tool refuses, write it with a Bash heredoc): the environment (CPU, RAM, OS, browser versions), the gate table G1–G8 (target, value, pass) per engine, and what only the owner can measure (Tauri webviews, iPhone, Android).
4. Commit as \`bench: results ${date}\` (no attribution). Do not push.
Return ran, resultsDir (absolute), gates and a summary (≤120 words). Also return worktreePath and branch in the summary text as "worktree=<path> branch=<branch>".`
}

function reportPrompt(state) {
  return `Write the final report of the pglite-cipher harness run and publish it.
Facts from the harness (trust these; check details with gh and git as needed):
${JSON.stringify(state)}
1. \`cd ${repoRoot} && git fetch -q && git checkout -q main && git merge -q --ff-only origin/main\`. Gather: every issue's state (\`gh issue list -R ${REPO} --state all --json number,title,state,labels\`), merged PRs, blocked issues with their last comment, the bench SUMMARY.md, and docs/plan/01-sqlcipher-comparison.md's parity table.
2. Write \`docs/report/${date}-harness-report.md\` in a new worktree branch \`agent/report-${date}\` (\`git worktree add ${repoRoot}/.claude/worktrees/report-${date} -b agent/report-${date} origin/main\`): what shipped, issue by issue, with PR links; what stopped and why; checkpoint findings; benchmark gates per engine with numbers; SQLCipher parity as it stands; what the owner must do next (device runs, owner-only boxes, the Journal-side plan files in docs/plan/journal/); risks. Plain, precise, no marketing. Push the branch, open a PR, and merge it (\`--merge --delete-branch\`). ${NO_CI}
3. Publish the same report as a Journal note through the journal MCP tools (load them with ToolSearch "journal"). First call get_authoring_guide for sections design, react, charts. Then create_note in folder ${JOURNAL_FOLDER}, titled "pglite-cipher: harness run ${date}". Make it an artifact-style report: a hero block, a react block with recharts for the benchmark numbers, an issue-status block, native tables for gates and parity. Rules from the owner: each tappable or accordion header is a \`div role="button"\`, not a bare \`<button>\` (Journal fixes button height); text wraps (\`min-w-0 break-words\`); no block taller than the screen with its own inner scrolling (use a one-open accordion); everything works at 390px. If the journal tools are unavailable, say so in the result and skip this step.
Return the note URL as https://journal.cloudx.run/${JOURNAL_FOLDER}/<noteId> (or "journal: unavailable") and the report PR URL.`
}

// ---------- per-item pipeline ----------
const needsSimplify = (it, w) => it.size !== 'S' || (w.linesChanged || 0) > 150 || (w.changedFiles || []).length > 4

async function runItem(it) {
  const tag = it.tag
  let model = it.model || (it.size === 'S' ? 'sonnet' : 'opus')
  let effort = it.effort || EFFORT[it.size] || 'high'
  const reviewModel = it.review || (/fable/.test(model) ? 'fable' : 'opus')

  let w = await agent(it.prompt || implementPrompt(it), { label: `${it.kind} ${tag}`, phase: it.kind === 'checkpoint' ? 'Checkpoint' : 'Implement', schema: IMPL_SCHEMA, isolation: 'worktree', model, effort })
  if (!w) return { tag, result: 'retry: implementer died', merged: false, infra: true }
  if (w.status === 'done' && !(w.changedFiles || []).length && it.kind === 'checkpoint') return { tag, result: 'checkpoint clean: ' + w.summary, merged: false, clean: true }

  if (w.status === 'done' && (w.changedFiles || []).length && it.kind === 'issue' && needsSimplify(it, w)) {
    const s = await agent(simplifyPrompt(it, w), { label: `simplify ${tag}`, phase: 'Simplify', schema: IMPL_SCHEMA, model: 'sonnet', effort: 'medium' })
    if (s?.summary) log(`${tag} simplify: ${s.summary.slice(0, 160)}`)
  }

  let verdict = null
  let review = null
  for (let round = 0; w.status === 'done'; round++) {
    const hasCode = (w.changedFiles || []).length > 0
    const runReview = hasCode && (round === 0 || (review?.findings || []).some((f) => f.severity !== 'minor'))
    const [rv, vd] = await parallel([
      () => (runReview ? agent(reviewPrompt(it, w), { label: `review ${tag}${round ? ` r${round + 1}` : ''}`, phase: 'Review', schema: REVIEW_SCHEMA, model: reviewModel, effort: 'high' }) : Promise.resolve(review)),
      () => agent(verifyPrompt(it, w), { label: `verify ${tag}${round ? ` r${round + 1}` : ''}`, phase: 'Verify', schema: VERIFY_SCHEMA, model: 'sonnet', effort: it.size === 'S' ? 'medium' : 'high' }),
    ])
    if (runReview && !rv) return { tag, result: 'retry: reviewer died', merged: false, infra: true }
    review = rv
    verdict = vd
    if (!verdict) return { tag, result: 'retry: verifier died', merged: false, infra: true }
    const serious = (review?.findings || []).filter((f) => f.severity !== 'minor')
      .map((f) => `[review ${f.severity}] ${f.file || ''}${f.line ? `:${f.line}` : ''} ${f.problem} → ${f.fix}`)
    const problems = [...verdict.problems, ...serious]
    if (verdict.verdict === 'pass' && !serious.length) break
    if (round === MAX_FIX_ROUNDS) {
      w = { ...w, status: 'stopped', condition: 'verification or review still failing after escalation', details: problems.join('; ') }
      break
    }
    if (round === 1) { model = LADDER[model] || 'opus'; effort = LADDER_EFFORT[model] || 'high' } // escalate for the last round
    log(`${tag}: ${problems.length} problems, fix round ${round + 1} on ${model}/${effort}`)
    const fixed = await agent(fixPrompt(it, w, problems), { label: `fix ${tag} r${round + 1}`, phase: 'Implement', schema: IMPL_SCHEMA, model, effort })
    if (!fixed) return { tag, result: 'retry: fixer died', merged: false, infra: true }
    w = { ...w, ...fixed, worktreePath: w.worktreePath, branch: w.branch }
  }

  if (dryRun) return { tag, result: `dry run: ${w.status}`, merged: false }
  const m = await agent(mergePrompt(it, w, verdict || {}, review), { label: `merge ${tag}`, phase: 'Merge', schema: MERGE_SCHEMA, model: 'haiku', effort: 'low' })
  return { tag, result: m?.result || `merge stage failed (${w.status})`, merged: !!m?.merged, review: review?.summary }
}

const issueItem = (r) => ({
  kind: 'issue', tag: `#${r.number}`, number: r.number, title: r.title, size: r.size,
  model: r.model, effort: r.effort, review: r.review,
  branch: `agent/${r.number}-${slug(r.title)}`,
})

const checkpointItem = (k, base, head) => {
  const cp = { k, base, head, branch: `checkpoint/${k}-${head.slice(0, 7)}` }
  return {
    kind: 'checkpoint', tag: `checkpoint ${k}`, number: null, title: `Checkpoint ${k}: review and simplify ${base.slice(0, 7)}..${head.slice(0, 7)}`,
    size: 'M', model: 'sonnet', effort: 'high', review: 'opus', branch: cp.branch, prompt: checkpointPrompt(cp), heavy: HEAVY_LOCAL,
  }
}

// ---------- main loop ----------
const report = []
let lastCheckpoint = null
let mergesSinceCheckpoint = 0
let checkpoints = 0
let lastSel = null
const infraRetries = {}

for (let wave = 1; wave <= maxWaves; wave++) {
  phase('Select')
  const sel = await agent(selectPrompt(), { label: `select wave ${wave}`, phase: 'Select', schema: SELECT_SCHEMA, model: 'haiku', effort: 'low' })
  if (!sel || !sel.ok) { log(`select failed: ${sel?.problem || 'agent died'}`); report.push({ tag: `wave ${wave}`, result: `stopped: ${sel?.problem || 'select died'}` }); break }
  lastSel = sel
  if (!lastCheckpoint) lastCheckpoint = sel.mainSha

  if (mergesSinceCheckpoint >= CHECKPOINT_EVERY || (!sel.ready.length && mergesSinceCheckpoint > 0)) {
    checkpoints++
    log(`checkpoint ${checkpoints} over ${lastCheckpoint.slice(0, 7)}..${sel.mainSha.slice(0, 7)}`)
    const row = await runItem(checkpointItem(checkpoints, lastCheckpoint, sel.mainSha))
    report.push(row)
    lastCheckpoint = sel.mainSha
    mergesSinceCheckpoint = 0
    if (row.merged) continue // re-select on the new main before the next wave
  }

  if (!sel.ready.length) { log(`wave ${wave}: nothing ready (${sel.skipped.length} skipped)`); break }
  log(`wave ${wave}: ${sel.ready.map((r) => `#${r.number}`).join(' ')} ready`)
  if (dryRun) { report.push(...sel.ready.map((r) => ({ tag: `#${r.number}`, result: 'dry run: would run' }))); break }

  const queue = sel.ready
    .filter((r) => (infraRetries[r.number] || 0) <= MAX_INFRA_RETRIES)
    .sort((a, b) => (b.number === sel.ciFailureIssue) - (a.number === sel.ciFailureIssue))
    .map(issueItem)
  if (!queue.length) { log(`wave ${wave}: only issues past their infra-retry cap are ready`); break }
  await parallel(Array.from({ length: Math.min(LANES, queue.length) }, (_, lane) => async () => {
    while (queue.length) {
      const it = { ...queue.shift(), heavy: heavyFor('box') }
      const row = await runItem(it).catch((e) => ({ tag: it.tag, result: `error: ${e.message}`, merged: false }))
      report.push(row)
      if (row.infra) infraRetries[it.number] = (infraRetries[it.number] || 0) + 1
      if (row.merged) mergesSinceCheckpoint++
      log(`${row.tag}: ${row.result}`)
    }
  }))
}

if (dryRun) return { report, skipped: lastSel?.skipped || [] }

phase('Bench')
const bench = await agent(benchPrompt(), { label: 'bench', phase: 'Bench', schema: BENCH_SCHEMA, isolation: 'worktree', model: 'sonnet', effort: 'high' })
if (bench?.ran) {
  const wt = /worktree=(\S+) branch=(\S+)/.exec(bench.summary || '')
  if (wt) {
    const m = await agent(mergePrompt({ tag: 'bench', number: null, title: `bench: results ${date}` }, { status: 'done', worktreePath: wt[1], branch: wt[2], summary: bench.summary, changedFiles: ['bench/results'] }, { checks: [], ownerOnly: [] }, null),
      { label: 'merge bench', phase: 'Merge', schema: MERGE_SCHEMA, model: 'haiku', effort: 'low' })
    report.push({ tag: 'bench', result: m?.result || 'bench merge failed', merged: !!m?.merged })
  }
}

phase('Report')
const state = {
  date,
  rows: report.map((r) => ({ item: r.tag, result: r.result })),
  checkpoints,
  bench: bench ? { ran: bench.ran, gates: bench.gates || [], summary: bench.summary } : null,
  stillSkipped: (lastSel?.skipped || []).map((s) => `#${s.number} ${s.reason}`),
}
const published = await agent(reportPrompt(state), { label: 'report', phase: 'Report', model: 'sonnet', effort: 'high' })
return { report, checkpoints, bench: state.bench, published }
