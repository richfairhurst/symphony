import { describe, expect, test } from "bun:test";
import { getHelpText, runCli, selectCliMode } from "./index";

describe("orchestrator CLI", () => {
  test("--help prints usage and exits 0", async () => {
    let out = "";
    const code = await runCli(["--help"], {
      stdout: (c) => {
        out += c;
      },
      stderr: () => {
        // ignore
      },
    });

    expect(code).toBe(0);
    expect(out).toContain("Usage:");
    expect(out).toContain("orchestrator");
    expect(out).toContain("--visual");
    expect(out).toContain("--json");
  });

  test("help text is stable", () => {
    const text = getHelpText();
    expect(text).toContain("Symphony Orchestrator");
  });

  test("unknown option exits 1", async () => {
    let err = "";
    const code = await runCli(["--nope"], {
      stdout: () => {
        // ignore
      },
      stderr: (c) => {
        err += c;
      },
    });

    expect(code).toBe(1);
    expect(err).toContain("Unknown option");
  });

  test("mode selection prefers visual on TTY", () => {
    expect(selectCliMode({ forceJson: false, forceVisual: false, isTty: true })).toBe("visual");
  });

  test("mode selection prefers json when not TTY", () => {
    expect(selectCliMode({ forceJson: false, forceVisual: false, isTty: false })).toBe("json");
  });

  test("mode selection honors explicit flags", () => {
    expect(selectCliMode({ forceJson: true, forceVisual: false, isTty: true })).toBe("json");
    expect(selectCliMode({ forceJson: false, forceVisual: true, isTty: false })).toBe("visual");
  });
});
