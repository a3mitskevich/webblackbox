# Archive fixtures

Archives written before the streaming exporter, kept so `archive-compat.test.ts` proves the
Player still opens them. Both hold the same five-event session (navigation, click, a failed
`POST /api/checkout` with a JSON response body blob, and a console error).

- `legacy-format1.webblackbox`: format 1 — plaintext `manifest.json`, no encryption, built with
  JSZip the way format 1 archives were laid out.
- `legacy-format2.webblackbox`: format 2 — written by `FlightRecorderPipeline.exportBundle` at
  commit `a1dea003` (JSZip, pretty-printed indexes, `none` chunk codec). Passphrase:
  `legacy-fixture-passphrase`.

Do not regenerate them with the current pipeline: their point is to stay old.
