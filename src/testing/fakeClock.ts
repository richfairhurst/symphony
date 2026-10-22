import type { Clock, TimeoutHandle } from "../scheduler/clock";

type Task = { at: number; fn: () => void; id: number };

export class FakeClock implements Clock {
  private now = 0;
  private nextId = 1;
  private tasks: Task[] = [];

  nowMs(): number {
    return this.now;
  }

  setTimeout(fn: () => void, ms: number): TimeoutHandle {
    const id = this.nextId++;
    const at = this.now + Math.max(0, Math.floor(ms));
    this.tasks.push({ at, fn, id });
    this.tasks.sort((a, b) => a.at - b.at || a.id - b.id);
    return id as unknown as TimeoutHandle;
  }

  clearTimeout(handle: TimeoutHandle): void {
    const id = handle as unknown as number;
    this.tasks = this.tasks.filter((t) => t.id !== id);
  }

  advanceBy(ms: number): void {
    const target = this.now + Math.max(0, Math.floor(ms));
    while (true) {
      const next = this.tasks[0];
      if (!next) break;
      if (next.at > target) break;
      this.now = next.at;
      this.tasks.shift();
      next.fn();
    }
    this.now = target;
  }
}
