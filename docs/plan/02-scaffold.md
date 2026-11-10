<!--
FILING: NEW issue in 2002Bishwajeet/pglite-cipher (placeholder PC-02). File this first: every other issue in this repository depends on it.
Title: Scaffold: TypeScript build, tests in Node and in Chromium/Firefox/WebKit, CI, licence placeholder
Labels: agent-ready
-->
## Context
`pglite-cipher` is a new, private repository: SQLCipher-style encryption at rest for PGlite. It has a README and `docs/` only. It will be consumed by Journal (2002Bishwajeet/journal) as a **git submodule, from source**: Journal's Vite build compiles `src/index.ts` directly and resolves `@electric-sql/pglite` from Journal's own `node_modules`. So this repository must work in two ways: on its own (install, build, test, later publish), and as a folder of TypeScript inside another project.

Cryptographic code that runs in webviews has to be tested in real browser engines, not only in Node: WebCrypto and IndexedDB differ between Chromium, Firefox and WebKit, and those differences are where encrypted stores break. The test setup is therefore part of the scaffold, not an afterthought.

Plan and background: `docs/plan/00-overview.md`, `docs/research/`.

## Change
1. **`package.json`:** `"name": "pglite-cipher"`, `"version": "0.0.0"`, `"private": true`, `"type": "module"`, `"license": "UNLICENSED"`, `"sideEffects": false`. `exports`: `"."` → `./src/index.ts` (types and default; a `dist` build comes with publishing), `"./testing"` → `./src/testing.ts`. `peerDependencies`: `@electric-sql/pglite` `^0.5.10`. **No runtime dependencies**, and a test that fails if `dependencies` is ever non-empty. `devDependencies`: `typescript`, `vitest`, `@vitest/browser` with the Playwright provider, `playwright`, `fast-check`, `fake-indexeddb`, `eslint`, `typescript-eslint`, `@electric-sql/pglite` pinned to `0.5.10` (the version Journal runs). Commit the lockfile. `engines.node` `>=22`.
2. **Scripts:** `build` (`tsc -p tsconfig.build.json`: emits `dist/` with declarations, used for type-checking and later for publishing), `typecheck`, `lint`, `test` (vitest, Node), `test:browser` (vitest browser mode, headless, projects `chromium`, `firefox`, `webkit`; accepts a path filter after `--`), `test:long` (sets `CIPHER_LONG=1`, used by later issues).
3. **TypeScript:** `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, target `ES2022`, `lib` `ES2023`, `DOM`, `WebWorker`. Source must compile under a stricter and a looser host: no `enum`, no namespaces, no path aliases, relative imports with explicit `.ts`/`.js` as the config requires, no Node built-ins in `src/` (lint rule `no-restricted-imports` for `node:*` under `src/`; tests may use them).
4. **Lint:** `typescript-eslint` strict type-checked; `no-explicit-any` as an error; `no-console` in `src/` except `console.warn`; `eslint-disable` needs a reason.
5. **Layout:** `src/index.ts` (exports `VERSION` and `FORMAT_VERSION = 1` for now), `src/testing.ts` (empty export for now), `test/` (mirrors `src/`), `test/smoke.test.ts`: (a) PGlite on `MemoryFS` starts and answers `SELECT 1` (proves the engine loads in each environment), (b) WebCrypto has AES-GCM, HKDF and `wrapKey`/`unwrapKey`, (c) IndexedDB accepts array keys and key-range deletes. The smoke test runs in Node (with `fake-indexeddb/auto` from a setup file used only for Node) and in all three browsers (real IndexedDB).
6. **Browser test serving:** PGlite needs its `.wasm` and `.data` files served and, for some features, cross-origin isolation. Configure the vitest browser server to send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`, and exclude `@electric-sql/pglite` from dependency pre-bundling if the WASM fails to load otherwise.
7. **CI** (`.github/workflows/ci.yml`, on push and pull request): one job each for `lint`, `build`, `test` on Node 22 and 24, and a matrix job `test:browser` for `chromium`, `firefox`, `webkit` on `ubuntu-latest` (install browsers with `npx playwright install --with-deps <browser>`). Jobs are separate so a browser failure names the browser. Cache npm. No secrets are needed.
8. **Licence placeholder:** `LICENSE` with: "Copyright (c) 2026 the pglite-cipher authors. All rights reserved. The licence will be chosen before this repository is made public; MIT is the intent." Do not add an MIT text yet, and do not invent a legal name for the holder: the owner decides both (`docs/plan/99-owner-questions.md`, question 13).
9. **`AGENTS.md`** (and a one-line `CLAUDE.md` that points to it): what the repository is; the commands; the rules every later issue relies on: no runtime dependencies; WebCrypto only, no hand-written or third-party cryptography in `src/`; never weaken or skip a property, fuzz or crash test to make it pass, report instead; every behaviour test runs in Node and in the three browsers unless it needs `node:crypto`; no secrets, keys or plaintext in errors or logs; issue format (Context, Change, Verification, STOP, Metadata with one `Depends on:` line); wrap heavy commands in `~/.claude/bin/heavy` on the owner's machines; never commit unless asked.
10. **Issue selector for the harness:** copy `scripts/harness/select.mjs` and its test from 2002Bishwajeet/journal, change `REPO` to `2002Bishwajeet/pglite-cipher`, keep the rest. Cross-repository dependencies cannot go on the `Depends on:` line (it takes same-repository `#n` only); issues name them in prose as `2002Bishwajeet/journal#n`.
11. **README:** add "Develop" (the commands) and "Use from another repository as a submodule" (import from `src/index.ts`; the host provides `@electric-sql/pglite`).
12. `.gitignore` (`node_modules`, `dist`, `test-results`, `bench/dist`), `.editorconfig`, `.nvmrc`.

## Verification
- `npm ci` exits 0 on a clean clone.
- `~/.claude/bin/heavy npm run build` exits 0 and writes `dist/index.js` and `dist/index.d.ts`.
- `~/.claude/bin/heavy npm run lint` exits 0.
- `~/.claude/bin/heavy npm test` passes the smoke test in Node.
- `~/.claude/bin/heavy npm run test:browser` passes the smoke test in Chromium, Firefox and WebKit.
- `node scripts/harness/select.mjs 1 --json` runs without a crash (the issue number does not matter).
- The CI workflow is green on the PR, with five visible jobs or more (lint, build, test, and one per browser).
- A scratch consumer check, described in the PR: a temporary Vite project outside the repository that imports `../pglite-cipher/src/index.ts` and has its own `@electric-sql/pglite` builds without errors (this is how Journal will consume it).

## STOP and comment on the issue if
- PGlite does not start inside vitest's browser mode in one of the three browsers (WASM loading, isolation headers). Report the browser and the error; propose Playwright Test with a static test page as the runner instead. Do not drop a browser.
- WebKit on Linux (Playwright's build) lacks a WebCrypto or IndexedDB feature the smoke test needs. Report which: it predicts trouble in WKWebView and WebKitGTK.
- Consuming the source from another project needs a build step after all.

## Metadata
Depends on: none
Size: M
Area: tooling, ci
Model: sonnet
Effort: high
