# Release checklist

For the owner, before the first release (`0.1.0`) and every one after it. Tick each line on the
release issue, with a link where there is one.

- [ ] **Nightly green for 7 days in a row.** The `nightly` workflow (`.github/workflows/nightly.yml`):
      the bench gates in Chromium, Firefox and WebKit, and the long suites in Node and the three
      browsers. The newest-PGlite job may be red; read why before the release.
- [ ] **Bench JSON from the devices**, attached to #3 or to the Journal checklist issue (J-16):
      macOS (WKWebView), iOS, Windows (WebView2) and Android (WebView), from the bench page run
      inside the Tauri shells (`bench/README.md`), each with the device and OS version.
- [ ] **`FORMAT.md` vectors reproduced by the independent decoder**: `test/format/independent.node.test.ts`
      passes, and `test/format/vectors.json` is unchanged since the format was frozen.
- [ ] **The frozen fixtures open**: `test/fs/reference.test.ts` (the v1 reference store) passes in
      Node, Chromium, Firefox and WebKit, and the CI compat jobs (a store written by WebKit opened by
      Chromium and Node, and the reverse) are green.
- [ ] **Version `0.1.0`** in `package.json` and `VERSION` in `src/index.ts`, committed, and a tag
      `v0.1.0` on that commit for Journal to pin its submodule to.
- [ ] **The README's limits read once more**: "What it protects, and what it does not", the
      SQLCipher table and `SECURITY.md` still match what the code does, and the date in
      `SECURITY.md` is the release date.
