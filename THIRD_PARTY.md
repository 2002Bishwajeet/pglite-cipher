# Third-party notices

## davidmuggleton/pglite-encrypted-fs

Source: <https://github.com/davidmuggleton/pglite-encrypted-fs> (MIT), the only other encrypted
PGlite filesystem (Node only). Adapted to this package's API; no filesystem or cryptography code was
taken from it.

- `test/fs/ported.test.ts` ports test scenarios from its `test/integration/pglite-basic.test.ts`,
  `test/integration/pglite-failure.test.ts` and `test/integration/pglite-pgvector.test.ts`.
- `bench/bench.ts` takes the shape of its `bench/` (`crypto-overhead.bench.ts`, `startup.bench.ts`,
  `operations.bench.ts`) for the `extras` crypto-overhead rows and the `ops` part.

Both files carry its copyright line beside ours (`SPDX-License-Identifier: Apache-2.0 AND MIT`).

Its licence:

```text
MIT License

Copyright (c) 2026 David Muggleton

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## @electric-sql/pglite-pgvector

A development dependency only (Apache-2.0, <https://github.com/electric-sql/pglite>): the pgvector
extension that the ported pgvector scenarios load. Nothing of it is in `src/` or shipped.
