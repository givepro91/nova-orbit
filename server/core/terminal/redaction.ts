const REDACTED = "[REDACTED]";

function isSecretKey(key: string): boolean {
  return /(?:api[_-]?key|authorization|bearer|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|credential|cookie)/i.test(key);
}

/**
 * Redact credentials before terminal-originated text crosses into durable
 * activity, review, bridge-event, or task-summary storage. This is deliberately
 * independent from shell parsing: terminal text is evidence, never executable
 * input, and common header/env/flag/URL forms are handled as opaque strings.
 */
export function redactTerminalText(value: string, maxLength?: number): string {
  const redacted = value
    .replace(/\b(Authorization\s*:\s*)(Bearer|Basic)\s+[^\s"'`,;]+/gi, `$1$2 ${REDACTED}`)
    .replace(/\bBearer\s+[^\s"'`,;]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b((?:Cookie|Set-Cookie)\s*:\s*)[^\r\n]+/gi, `$1${REDACTED}`)
    .replace(
      /\b([A-Z_][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\s*(=|:)\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      `$1=${REDACTED}`,
    )
    .replace(/(--(?:api[-_]?key|access[-_]?token|token|secret|password|credential))(?:=|\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, `$1=${REDACTED}`)
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|password|credential)=)[^&#\s]+/gi, `$1${REDACTED}`)
    .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|xox[baprs]-[A-Za-z0-9-]+|sk-[A-Za-z0-9_-]{12,})\b/g, REDACTED)
    .replace(/\b((?:https?|ssh|git|postgres(?:ql)?|mysql|redis):\/\/)([^\s/@:]+):([^\s/@]+)@/gi, `$1${REDACTED}@`);
  return maxLength == null ? redacted : redacted.slice(0, maxLength);
}

/** Redact arbitrary JSON-compatible terminal evidence without changing shape. */
export function redactTerminalValue(value: unknown, seen = new Set<object>()): unknown {
  if (typeof value === "string") return redactTerminalText(value);
  if (value == null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) throw new Error("terminal evidence must not contain circular references");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => redactTerminalValue(item, seen));
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
      key,
      isSecretKey(key) ? REDACTED : redactTerminalValue(item, seen),
    ]));
  } finally {
    seen.delete(value);
  }
}

export function terminalSecretKey(key: string): boolean {
  return isSecretKey(key);
}

export const TERMINAL_REDACTED = REDACTED;
