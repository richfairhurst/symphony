export type RetryKind = "continuation" | "failure" | "no_slots";

export function continuationDelayMs(): number {
  return 1000;
}

export function failureDelayMs(attempt: number, maxRetryBackoffMs: number): number {
  const a = Math.max(1, Math.floor(attempt));
  const base = 10_000 * 2 ** (a - 1);
  return Math.min(base, Math.max(0, Math.floor(maxRetryBackoffMs)));
}
