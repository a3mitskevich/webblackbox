export function redactText(input: string, maxLength = 120): string {
  const compact = input.replace(/\s+/g, " ").trim();
  const redacted = compact
    .replaceAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[redacted-email]")
    .replaceAll(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [redacted-token]")
    .replaceAll(/([?&](?:token|auth|password|secret|api[_-]?key)=)[^&]+/gi, "$1[redacted]")
    .replaceAll(/\b((?:token|auth|password|secret|api[_-]?key)\s*=\s*)[^\s,&;]+/gi, "$1[redacted]")
    .replaceAll(/\b((?:token|auth|password|secret|api[_-]?key)\s*:\s*)[^\s,;]+/gi, "$1[redacted]")
    .replaceAll(
      /("?(?:token|auth|password|secret|api[_-]?key)"?\s*:\s*)"([^"\\]*(?:\\.[^"\\]*)*)"/gi,
      '$1"[redacted]"'
    )
    .replaceAll(/[A-Fa-f0-9]{32,}/g, "[redacted-hex]")
    .replaceAll(/[A-Za-z0-9+/]{48,}={0,2}/g, "[redacted-base64]");

  if (redacted.length <= maxLength) {
    return redacted;
  }

  return `${redacted.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
