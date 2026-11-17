# Where to keep the key

`EncryptedFs` takes a key-encryption key (KEK). It's a non-extractable AES-GCM `CryptoKey`, usable only for `wrapKey` and `unwrapKey`. The package wraps its own random data key with it. Whoever has the KEK and a copy of the store can read the data, so the KEK must live somewhere a copy of the browser profile doesn't reach.

Never log the key, put it in an error, or send it to a server you don't control.

## Phone and desktop apps (recommended)

Keep 32 random bytes in the platform's secret store, hand them to the webview, and import them:

```ts
import { importKek } from 'pglite-cipher';

const key = await importKek(bytes); // zeroes `bytes` once imported
```

- **iOS (WKWebView):** store the bytes in the Keychain (for example with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) and pass them to the page through a `WKScriptMessageHandler` reply.
- **Android (WebView):** Keystore keys can't be exported. Instead, store the 32 bytes encrypted with a Keystore key, decrypt them in native code, and pass them through a JavaScript interface.
- **Tauri and other desktop shells:** read the bytes from the OS keychain (macOS Keychain, Windows Credential Manager, Secret Service) in the native side, and return them from a command.

Create the bytes once, on first launch, with a secure random generator, and keep them for the life of the database.

## Browser only

Without a native side, generate a non-extractable key and keep the `CryptoKey` object itself in IndexedDB. Structured clone stores it without ever exposing the bytes:

```ts
const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['wrapKey', 'unwrapKey']);
// store `key` in an IndexedDB object store, and read it back on the next start
```

This protects less: anyone with a copy of the browser profile has both the store and the key. It still stops someone who has only the exported IndexedDB data, and it keeps the key out of JavaScript strings.

## A passphrase

The package has no passphrase KDF (see [`SECURITY.md`](../../SECURITY.md)), and a passphrase must never be passed in as a key. If the user must type a secret, derive the KEK from it in your app with WebCrypto, using a random salt stored next to the database:

```ts
const salt = crypto.getRandomValues(new Uint8Array(16)); // once; store it, it is not secret
const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
const key = await crypto.subtle.deriveKey(
  { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
  base,
  { name: 'AES-GCM', length: 256 },
  false,
  ['wrapKey', 'unwrapKey'],
);
```

A derived key is only as strong as the passphrase: a short or common one can be guessed offline from a copy of the store. Prefer a random key in the keychain, and use the passphrase only to unlock it.
