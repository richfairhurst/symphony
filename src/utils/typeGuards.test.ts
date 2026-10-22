import { describe, expect, test } from "bun:test";
import { asString, isRecord } from "./typeGuards";

describe("typeGuards", () => {
  describe("isRecord", () => {
    test("true for non-null non-array objects", () => {
      expect(isRecord({})).toBe(true);
      expect(isRecord({ a: 1 })).toBe(true);
      expect(isRecord(new Date())).toBe(true);
    });

    test("false for null, arrays, and primitives", () => {
      expect(isRecord(null)).toBe(false);
      expect(isRecord([])).toBe(false);
      expect(isRecord(1)).toBe(false);
      expect(isRecord("x")).toBe(false);
      expect(isRecord(true)).toBe(false);
      expect(isRecord(() => {})).toBe(false);
    });
  });

  describe("asString", () => {
    test("returns string values", () => {
      expect(asString("x")).toBe("x");
      expect(asString("")).toBe("");
    });

    test("returns undefined for non-strings", () => {
      expect(asString(undefined)).toBeUndefined();
      expect(asString(null)).toBeUndefined();
      expect(asString(1)).toBeUndefined();
      expect(asString({})).toBeUndefined();
    });
  });
});
