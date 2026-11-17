# Demo

One page, with no build step and no framework, that shows three things in your own browser:

1. **Speed:** write rows to plain `idb://` and to an encrypted store, then reopen each.
2. **Proof:** search the raw IndexedDB bytes for a word you inserted. It's in the plain store and not in the encrypted one.
3. **Tamper:** flip one bit in a stored block. The next open fails with `CorruptStoreError`.

Live: <https://2002bishwajeet.github.io/pglite-cipher/>

Run it locally from the repository root:

```sh
npm ci && npm run build
npx serve .            # or any static file server
# open http://localhost:3000/examples/demo/
```

`index.html` loads PGlite from jsDelivr and pglite-cipher from `../../dist/` through an import map. In your own app, `npm install pglite-cipher @electric-sql/pglite` and import them as usual. The checks live in `demo.mjs`, and `test/demo.browser.test.ts` runs them in Chromium, Firefox and WebKit.
