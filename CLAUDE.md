# CLAUDE.md - pglite-cipher

Behavioural guidelines (after Andrej Karpathy's notes on LLM coding pitfalls). They apply to every agent in this repository.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## What this repository is

SQLCipher-style encryption at rest for PGlite (AES-256-GCM through WebCrypto, blocks in IndexedDB), consumed by Journal's native apps as an optional git submodule. Private. The plan is `docs/plan/` (start at `00-overview.md`); background in `docs/research/`. Once the scaffold lands, `AGENTS.md` has the commands and layout.

## Rules

- **Security code:** WebCrypto primitives only; no hand-written or third-party cryptography in `src/`. No runtime dependencies. No keys, plaintext or secrets in errors, logs or test snapshots.
- **Never weaken, skip or loosen** a property, fuzz, crash or conformance test to make it pass. Report it (STOP) instead.
- Every behaviour test runs in Node and in Chromium, Firefox and WebKit, unless it needs `node:crypto`.
- Commit only on your own harness branch (`agent/<n>-…`, `checkpoint/…`); never push to `main`. No attribution lines in commits or PRs (no Co-Authored-By, no "Generated with").
- **16 GB machine:** run every install/build/lint/test/bench through `~/.claude/bin/heavy <cmd> > /tmp/pc-<issue>-<step>.log 2>&1; echo exit=$?`, in the foreground. Read `tail -40` of the log, plus `grep -nE 'FAIL|Error|✗|×' <log> | head -40` when it failed. Never let full output into context.
- **WebKit** doesn't run on this host: use `scripts/harness/webkit.sh <cmd>` (Playwright's container image through podman). Exit 3 means WebKit isn't available here; record it as "CI covers it", not as a pass. So `npm run test:browser` for all engines means `npm run test:browser -- --project chromium --project firefox` plus `scripts/harness/webkit.sh npm run test:browser -- --project webkit`.
- **Never wait on CI.** Local verification is the merge gate. Don't poll `gh pr checks` or sleep. CI results are read once, at checkpoints.
- **Lean context:** read only the issue, the plan sections it cites and the files you change. Return short summaries (≤150 words) to the harness.

## Harness

`docs/HARNESS.md`: how the weekend run works, how to start, watch and resume it.
