import { describe, expect, test } from "bun:test";
import { extractSessionId } from "./utils";

describe("runner utils", () => {
  describe("extractSessionId", () => {
    test("returns undefined for non-objects", () => {
      expect(extractSessionId(null)).toBeUndefined();
      expect(extractSessionId("x")).toBeUndefined();
      expect(extractSessionId(123)).toBeUndefined();
      expect(extractSessionId([])).toBeUndefined();
    });

    test("extracts from top-level fields", () => {
      expect(extractSessionId({ session_id: "s1" })).toBe("s1");
      expect(extractSessionId({ sessionId: "s2" })).toBe("s2");
      expect(extractSessionId({ sessionID: "s3" })).toBe("s3");
      expect(extractSessionId({ run_id: "r1" })).toBe("r1");
      expect(extractSessionId({ runId: "r2" })).toBe("r2");
      expect(extractSessionId({ id: "i1" })).toBe("i1");
    });

    test("extracts from nested session and part shapes", () => {
      expect(extractSessionId({ session: { id: "s1" } })).toBe("s1");
      expect(extractSessionId({ session: { session_id: "s2" } })).toBe("s2");
      expect(extractSessionId({ session: { sessionId: "s3" } })).toBe("s3");
      expect(extractSessionId({ session: { sessionID: "s4" } })).toBe("s4");

      expect(extractSessionId({ part: { session_id: "p1" } })).toBe("p1");
      expect(extractSessionId({ part: { sessionId: "p2" } })).toBe("p2");
      expect(extractSessionId({ part: { sessionID: "p3" } })).toBe("p3");
    });

    test("skips empty/whitespace candidates", () => {
      expect(extractSessionId({ session_id: "   " })).toBeUndefined();
      expect(extractSessionId({ session: { id: "\n\t" } })).toBeUndefined();
      expect(extractSessionId({ part: { sessionID: "" } })).toBeUndefined();
    });
  });
});
