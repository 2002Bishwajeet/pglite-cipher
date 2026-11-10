<!--
FILING: REWRITES 2002Bishwajeet/journal#553 (replace its whole body with this; keep the number).
New title: Consume pglite-cipher as an optional private submodule (build switch, native CI, harness worktrees)
Labels: remove needs-design; add agent-ready only when 2002Bishwajeet/pglite-cipher's scaffold issue (plan file 02) is closed
Why the rewrite: the encrypted filesystem moved to its own private repository (owner decision 2026-11-10). Everything the old #553 asked for is now the pglite-cipher issues (plan files 02–11). What is left for Journal is how to consume it.
-->
## Context
Journal's native apps will encrypt the local database with `pglite-cipher`, a PGlite filesystem that lives in the private repository `2002Bishwajeet/pglite-cipher`. Owner decisions (2026-11-10):

- **Premium features stay private.** The public Journal repository is the PWA and the rest of the open app. Encryption is native-only and paid, so its code is in a private repository.
- **The submodule is optional.** A clone of Journal without it must build and test green, and **the PWA never imports it**.
- **Only native builds that include encryption need it.** Only those CI jobs get a credential. Public CI and the Cloudflare PWA deploy do not fetch it.

This issue adds the submodule and the switch around it. It does not use the filesystem yet (#1017 does). Cross-repository dependency, which the `Depends on:` line cannot express: `2002Bishwajeet/pglite-cipher` must have its scaffold merged (plan file `02-scaffold.md`), so that `src/index.ts` exists and exports `VERSION`.

A public repository whose `.gitmodules` names a private repository is fine for a plain `git clone`. `git clone --recurse-submodules` and `git submodule update` fail for people without access; the README must say so.

## Change
1. **Submodule.** Add `vendor/pglite-cipher` with the **relative** URL `../pglite-cipher.git` in `.gitmodules` (it follows whichever protocol the Journal clone uses, and resolves to nothing useful in a fork, which is intended). Pin the current `main` commit of pglite-cipher. In `.gitmodules` also set `update = none` for it, so that `git clone --recurse-submodules` and a bare `git submodule update --init` skip it instead of failing for people without access; whoever needs it runs `git submodule update --init --checkout vendor/pglite-cipher`. Verify that behaviour with a scratch clone using a URL you cannot read; if `update = none` does not make the recursive clone succeed, drop it and keep the README note.
2. **One switch: `VITE_NATIVE_ENCRYPTION`.** Unset or `0` (every PWA and public build): encryption code is not in the bundle. `1` (native builds with encryption): it is, and the submodule must be present.
   - `vite.config.ts` and `vitest.config.ts`: alias `pglite-cipher` to `vendor/pglite-cipher/src/index.ts` when the flag is `1`, else to `src/lib/db/cipher/unavailable.ts`. With the flag `1` and the file missing, fail the build at config time with: "VITE_NATIVE_ENCRYPTION=1 needs the private submodule: git submodule update --init vendor/pglite-cipher".
   - `src/lib/db/cipher/unavailable.ts`: exports the same names Journal uses from the package, as functions and classes that throw `Error("Encryption is not part of this build")`, and `export const CIPHER_AVAILABLE = false`. Keep it to the names actually imported.
   - `src/lib/db/cipher/index.ts`: the **only** module in `src/` allowed to import `pglite-cipher` (add an ESLint `no-restricted-imports` rule for every other file). It exports `cipherEnabled = import.meta.env.VITE_NATIVE_ENCRYPTION === '1'` and re-exports what Journal needs. Callers must reach it through `if (cipherEnabled) { await import('@/lib/db/cipher') }`, so that with the flag off the bundler drops the branch and the chunk.
   - Declare `VITE_NATIVE_ENCRYPTION` in `src/globals.d.ts` (`ImportMetaEnv`).
3. **Type-checking both ways.** `npm run build` (public) must pass with the submodule absent: `tsconfig.app.json` maps `pglite-cipher` to `src/lib/db/cipher/unavailable.ts`. Add `tsconfig.native.json` (extends the app config, maps `pglite-cipher` to `vendor/pglite-cipher/src/index.ts`, includes `vendor/pglite-cipher/src`) and a script `typecheck:native`. Add `build:native`: `VITE_NATIVE_ENCRYPTION=1` + `typecheck:native` + `vite build`. Do not change `beforeBuildCommand` in `src-tauri/tauri.conf.json` here; #1017 switches the native build to `build:native`.
4. **Stub drift guard.** `src/__tests__/cipherStub.test.ts`: always checks that `unavailable.ts` throws the documented error and `CIPHER_AVAILABLE` is false; **when the submodule is present** (`existsSync('vendor/pglite-cipher/src/index.ts')`), also checks that every name the stub exports exists in the real module with the same kind (function or class). Skipped parts are reported as skipped, not passed.
5. **The PWA build is identical with or without the submodule.** `scripts/check-pwa-build-identical.mjs`: runs `vite build` (flag unset) into two output directories, once as is and once with `vendor/pglite-cipher` hidden (rename the directory, restore it in a `finally`), and compares every file's SHA-256, ignoring nothing. Exit non-zero with the list of differing files. It refuses to run when the submodule is absent (it cannot prove anything then) and says so with exit code 2.
6. **Tests that need the real package** use one helper, `src/__tests__/cipherAvailable.ts` (`describe.skipIf(!present)`), so a public clone stays green and the native job runs them.
7. **CI.**
   - Public workflows (`tests.yml`, `e2e.yml`, `deploy-cloudflare.yml`, `manual-release.yml`, `mcp-release.yml`, `ios-safari.yml`, `e2e-live-*.yml`): **no change**. They check out without submodules and build the PWA. State in the PR that each was read and left alone.
   - New `.github/workflows/native-encryption.yml`, on pushes to `main` and on pull requests **from this repository only** (`if: github.event.pull_request.head.repo.full_name == github.repository || github.event_name != 'pull_request'`; fork PRs have no secrets and must not show a red check): check out, then fetch the submodule (`git submodule update --init --checkout vendor/pglite-cipher`; `submodules: recursive` alone skips a submodule marked `update = none`) with a **read-only deploy key** for pglite-cipher from the secret `PGLITE_CIPHER_DEPLOY_KEY` (through `GIT_SSH_COMMAND` or an ssh-agent step; the key can read that one repository and nothing else). Then: `npm ci`, `npm run typecheck:native`, the vitest files that use `cipherAvailable`, `node scripts/check-pwa-build-identical.mjs`, `npm run build:native`. Later issues add their specs to this workflow.
   - The owner creates the deploy key and the secret (a checklist line in the PR). Until then the workflow fails at checkout with a clear message, and it is not a required check.
8. **Harness worktrees.** In `.claude/workflows/implement-epic.js`, next to the `node_modules` symlink instruction (around line 81), add: if `<repoRoot>/vendor/pglite-cipher/src/index.ts` exists, run `git submodule update --init --checkout --reference <repoRoot>/.git/modules/vendor/pglite-cipher vendor/pglite-cipher` in the worktree; if it does not exist, continue without it. Add to the issue template text in `.claude/commands/implement.md`: an issue that needs the private package says so under STOP ("the submodule is not available on this machine").
9. **Docs.** `README.md`: "Journal builds without `vendor/pglite-cipher`. It is a private, optional submodule used only by native builds with encryption. People without access can ignore it." `AGENTS.md`: a short "Private submodule" section (the flag, the two tsconfigs, the single import module, how to bump the pin: `git -C vendor/pglite-cipher fetch && git -C vendor/pglite-cipher checkout <tag> && git add vendor/pglite-cipher`), and the project-structure entry.
10. Dependabot: do not add a `gitsubmodule` ecosystem (it cannot read the private repository). Pins are bumped by hand, by the issue that needs the newer commit.

## Verification
- With the submodule **absent** (a fresh clone, or `git submodule deinit -f vendor/pglite-cipher`): `~/.claude/bin/heavy npm run build`, `~/.claude/bin/heavy npm run lint` and `~/.claude/bin/heavy npm run test` exit 0, and `grep -R "pglite-cipher" dist` finds nothing.
- With the submodule **present**: the same three exit 0; `~/.claude/bin/heavy npm run typecheck:native` exits 0; `~/.claude/bin/heavy npm run build:native` exits 0.
- `~/.claude/bin/heavy node scripts/check-pwa-build-identical.mjs` exits 0 with the submodule present, and exits 2 with it absent.
- `VITE_NATIVE_ENCRYPTION=1 npx vite build` with the submodule absent fails with the documented message.
- `src/__tests__/cipherStub.test.ts` passes in both states; with the submodule present it reports the drift checks as run.
- `~/.claude/bin/heavy npm run e2e` passes unchanged.
- The PR lists every workflow file and what was (not) changed, and the owner checklist: create the deploy key, add `PGLITE_CIPHER_DEPLOY_KEY`.

## STOP and comment on the issue if
- `vendor/pglite-cipher` cannot be fetched on this machine (no access). Do not replace it with a copy of the code.
- Any file in `dist/` differs between the two PWA builds. Name the file and what differs; do not add it to an ignore list.
- The PWA bundle cannot be kept free of the package without removing a static import that something else needs.
- A public workflow would need a secret to keep working.

## Metadata
Depends on: none
Size: M
Area: build, ci, native, security
Model: opus
Effort: high
