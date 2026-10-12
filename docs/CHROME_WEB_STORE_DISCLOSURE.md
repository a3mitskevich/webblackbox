# Chrome Web Store Disclosure Source

> Inherited from upstream. This fork is not listed on the Chrome Web Store. The text is kept because the `store-safe` build profile still exists (`pnpm --filter @webblackbox/extension build:store-safe` in `apps/extension`) and describes that build, not the default one.

## Single Purpose

WebBlackbox records browser debugging data for sessions that the user explicitly starts, then lets the user export an encrypted `.webblackbox` archive for local debugging or support.

## Permission Rationale

- `activeTab`: grants temporary access to the active tab after a user gesture.
- `scripting`: injects capture code only after recording starts.
- `storage`: stores local settings, the per-browser-session key for encrypted local recordings, and local audit records.
- `offscreen`: runs the recording pipeline (chunking, indexing, encrypted local storage, export) in an offscreen document.
- `alarms`: deletes stopped, unexported recordings of profiles that set a retention time.
- `notifications`: asks the user to export a stopped recording, and warns when a recording falls back to page-side capture, while the popup is closed.
- `tabCapture`: tab video, when the recording profile asks for it. The Full engine needs `debugger`, which this build does not request, so Full profiles fall back to page-side capture here.
- `downloads`: saves user-requested archive exports.

The store-safe profile does not request `debugger`, `tabs`, `webRequest`, persistent `<all_urls>` host permissions, or always-on all-sites content scripts.

## Privacy Practices

What is captured is decided by the recording profile in effect. The default profile (`Maximum`) records as completely as the build allows, without content masking, because every archive is encrypted; the `Light` profile and profiles that keep the base policy mask or disable raw input values, DOM text, screenshots, storage values, cookies, raw headers, request bodies, and response bodies; masking applies the user's rules on a best-effort basis. Recordings are kept locally, encrypted at rest with a key that is discarded when the browser closes; the export passphrase is remembered only in memory until the browser closes. Exports include a privacy manifest and scanner result.

Every export is encrypted with a user-chosen passphrase of at least 8 characters, and public shares accept only encrypted archives. The public share server does not receive archive passphrases or decryption keys.

## Limited Use Statement

WebBlackbox uses captured data only to provide user-requested debugging, playback, export, and share functionality. Captured data is not sold, used for advertising, or used for unrelated profiling.
