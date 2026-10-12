Tester's report:

> {{report}}

Recording: {{archivePath}}
Passphrase: {{passphrase}}

Find the root cause of the reported problem and the key evidence for it in the recording:
requests (method, URL, status), errors (message, where), the element the user interacted with,
and the relevant page, storage or connection state.

End your answer with exactly one fenced JSON block in this shape:

```json
{
  "rootCause": "one or two sentences: what goes wrong and why",
  "evidence": ["each concrete fact from the recording that supports it"],
  "missingData": ["data you needed but the recording did not contain"],
  "confidence": "high | medium | low"
}
```
