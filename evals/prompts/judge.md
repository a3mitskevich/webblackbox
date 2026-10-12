You grade a bug analysis against the known root cause of a seeded bug. Reply with JSON only.

Known root cause:
{{rootCause}}

Key evidence a correct analysis points to:
{{keyEvidence}}

The analysis to grade (root cause and evidence the analyst stated):
{{answer}}

The analysis passes when it identifies the same failure mechanism as the known root cause (the
wording may differ, and extra correct detail is fine). It fails when it names a different cause,
only restates the symptom, hedges between several causes without settling on the right one, or
says the cause cannot be determined.

Reply with exactly: {"pass": true | false, "reason": "one sentence"}
