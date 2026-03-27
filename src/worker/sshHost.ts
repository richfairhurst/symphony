export type SshHostValidationError = {
  reason: string;
};

const ALLOWLIST_RE = /^[A-Za-z0-9_.@:-]+$/;
const ANY_WHITESPACE_RE = /\s/;

export function validateSshHost(value: string): { ok: true } | { ok: false; error: SshHostValidationError } {
  if (value.trim() === "") {
    return { ok: false, error: { reason: "host is empty" } };
  }

  if (ANY_WHITESPACE_RE.test(value)) {
    return { ok: false, error: { reason: "host must not contain whitespace" } };
  }

  if (value.startsWith("-")) {
    return { ok: false, error: { reason: "host must not start with '-'" } };
  }

  if (!ALLOWLIST_RE.test(value)) {
    return {
      ok: false,
      error: { reason: `host contains invalid characters (must match ${ALLOWLIST_RE.source})` },
    };
  }

  return { ok: true };
}
