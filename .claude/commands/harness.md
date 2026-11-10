---
description: Start the unattended pglite-cipher harness (waves until nothing is ready, then bench + report)
argument-hint: [--dry] [--waves N]
---
Start the pglite-cipher harness. Invoking this command is the owner's opt-in to the `cipher-harness` workflow.

1. `cd` to this checkout. It must be on `main` and clean apart from `.claude/`; if not, stop and say what is dirty.
2. `node scripts/harness/select.mjs --all` and print the table.
3. Run the saved workflow `cipher-harness` with args `{ "repoRoot": "<absolute path of this checkout>", "date": "<today, YYYY-MM-DD>", "maxWaves": <N from --waves, default 30>, "dryRun": <true if --dry> }`.
4. Don't poll it. It runs to the end by itself. When it finishes, print its report as a table `item | result`, plus the Journal report link it returns.

Resume after a crash or restart: run the workflow again with the same `scriptPath` and `resumeFromRunId` from the last run (`/workflows` shows it). Completed stages replay from cache, and the select stage re-reads GitHub, so nothing is done twice.
