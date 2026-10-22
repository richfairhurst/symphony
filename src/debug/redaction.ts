import { redactObviousSecrets } from "../opencode/sessionIntrospection";
import { isRecord } from "../utils/typeGuards";

const REDACT_KEY_RE = /(^|_)(api[_-]?key|token|secret|password|authorization)($|_)/i;

export function redactBundleValue(value: unknown): unknown {
  if (typeof value === "string") return redactObviousSecrets(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.map((v) => redactBundleValue(v));
  if (!isRecord(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (REDACT_KEY_RE.test(k)) {
      out[k] = "[REDACTED]";
      continue;
    }
    out[k] = redactBundleValue(v);
  }
  return out;
}

export function redactBundleString(s: string): string {
  return redactObviousSecrets(s);
}
