# AGENTS.md - pglite-cipher

SQLCipher-style encryption at rest for PGlite (AES-256-GCM through WebCrypto, blocks in IndexedDB). It can be used from source as a git submodule: the host's Vite build compiles `src/index.ts` and resolves `@electric-sql/pglite` from the host's `node_modules`. Design: `docs/design/` (start at `README.md`); on-disk format: `FORMAT.md`. Behaviour guidelines: `CLAUDE.md`.

## Layout

- `src/index.ts` public API (`VERSION`, `FORMAT_VERSION`); `src/testing.ts` test helpers exported as `pglite-cipher/testing`.
- `test/` mirrors `src/`. `*.node.test.ts` files run in Node only; every other test runs in Node and in Chromium, Firefox and WebKit.
- `bench/` is the benchmark page and its headless runner (`bench/README.md`).

## Commands

| Command | What it does |
| --- | --- |
| `npm ci` | install from the lockfile |
| `npm run build` | `tsc -p tsconfig.build.json`, emits `dist/` with declarations |
| `npm run typecheck` | `tsc -p tsconfig.json` (src, tests, scripts, configs) |
| `npm run lint` | ESLint, typescript-eslint strict type-checked |
| `npm test` | vitest in Node (with `fake-indexeddb`) |
| `npm run test:browser` | vitest browser mode, headless; all three engines, or `-- --project chromium` (repeatable) and a path filter after `--` |
| `npm run test:long` | Node tests with `CIPHER_LONG=1` (long fuzz, property, crash and soak runs; `test/long.ts`) |
| `npm run bench:build` | the benchmark page, `bench/dist` (`bench/README.md`) |

Install browsers once with `npx playwright install chromium firefox webkit` (add `--with-deps` on a fresh Linux machine). Playwright's WebKit supports only some Linux distributions; where it doesn't run, use Playwright's container image or leave WebKit to CI.

## Rules

- **No runtime dependencies.** A test fails if `dependencies` is ever non-empty. `@electric-sql/pglite` is a peer dependency.
- **WebCrypto only.** No hand-written or third-party cryptography in `src/`. No Node built-ins in `src/` (lint-enforced); tests may use them.
- **Never weaken or skip** a property, fuzz, crash or conformance test to make it pass. Report it instead.
- **Every behaviour test runs in Node and in the three browsers**, unless it needs `node:crypto` (name it `*.node.test.ts`).
- **No secrets, keys or plaintext** in errors, logs or test snapshots.
- TypeScript must compile under a stricter and a looser host: no `enum`, no namespaces, no path aliases, relative imports with an explicit `.ts` extension. `eslint-disable` comments need a reason.
- **Memory:** the Firefox browser suite peaks at about 8.5 GB with one file at a time (`--maxWorkers=1`), and at about 14 GB with the default. Use one worker on machines with 16 GB or less.
- **Work on a branch** and open a pull request; never push to `main`.
