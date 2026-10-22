import type { SlotConfig, SlotUsage } from "../scheduler/slots";
import { availableHostSlots } from "../scheduler/slots";

export type HostSelectionResult =
  | { ok: true; host: string }
  | { ok: false; reason: "no_ssh_hosts" | "no_ssh_capacity" };

export function selectSshHost(opts: {
  sshHosts: string[];
  slotConfig: SlotConfig;
  usage: SlotUsage;
}): HostSelectionResult {
  const pool = opts.sshHosts.map((h) => h.trim()).filter((h) => h !== "");
  if (pool.length === 0) return { ok: false, reason: "no_ssh_hosts" };

  const scored = pool.map((host, idx) => {
    const used = opts.usage.runningByHost[host] ?? 0;
    const avail = availableHostSlots(opts.slotConfig, opts.usage, host);
    return { host, idx, used, avail };
  });

  const candidates = scored
    .filter((s) => s.avail > 0)
    .sort((a, b) => {
      if (a.avail !== b.avail) return b.avail - a.avail;
      if (a.used !== b.used) return a.used - b.used;
      return a.idx - b.idx;
    });

  const chosen = candidates[0];
  if (!chosen) return { ok: false, reason: "no_ssh_capacity" };
  return { ok: true, host: chosen.host };
}
