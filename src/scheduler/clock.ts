export type TimeoutHandle = ReturnType<typeof setTimeout>;

export type Clock = {
  nowMs: () => number;
  setTimeout: (fn: () => void, ms: number) => TimeoutHandle;
  clearTimeout: (handle: TimeoutHandle) => void;
};

export const systemClock: Clock = {
  nowMs: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
};
