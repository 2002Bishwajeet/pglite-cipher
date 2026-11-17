# Release checklist

Before the first release (`0.1.0`) and every one after it. Tick each line on the
release issue, with a link where there is one.

- [ ] **Nightly green for 7 days in a row.** The `nightly` workflow (`.github/workflows/nightly.yml`):
      the bench gates in Chromium, Firefox and WebKit, and the long suites in Node and the three
      browsers. The newest-PGlite job may be red; read why before the release.
- [ ] **Device numbers are current**: the device results in `docs/design/performance.md` were measured
      on this release's format, or the page says which release they come from.
- [ ] **`FORMAT.md` vectors reproduced by the independent decoder**: `test/format/independent.node.test.ts`
      passes, and `test/format/vectors.json` is unchanged since the format was frozen.
- [ ] **The frozen fixtures open**: `test/fs/reference.test.ts` (the v1 reference store) passes in
      Node, Chromium, Firefox and WebKit, and the CI compat jobs (a store written by WebKit opened by
      Chromium and Node, and the reverse) are green.
- [ ] **Version `0.1.0`** in `package.json` and `VERSION` in `src/index.ts`, committed, and a tag
      `v0.1.0` on that commit for Journal to pin its submodule to.
- [ ] **The limits read once more**: the README's "What it does not protect", the SQLCipher
      table in `docs/design/comparison.md` and `SECURITY.md` still match what the code does, and the date in
      `SECURITY.md` is the release date.
