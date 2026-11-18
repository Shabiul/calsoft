import { describe, expect, it } from "vitest";
import { backoffDelay, dedupeKey, isFinalAttempt } from "./backoff";

const cfg = { baseMs: 1000, capMs: 60_000, jitter: 0 };
describe("backoffDelay", () => {
  it("doubles each attempt", () => {
    expect([1, 2, 3, 4].map((n) => backoffDelay(n, cfg))).toEqual([1000, 2000, 4000, 8000]);
  });
  it("is capped", () => expect(backoffDelay(30, cfg)).toBe(60_000));
  it("applies bounded jitter", () => {
    const j = { ...cfg, jitter: 0.2 };
    expect(backoffDelay(3, j, () => 0)).toBe(3200);
    expect(backoffDelay(3, j, () => 1)).toBe(4800);
    expect(backoffDelay(3, j, () => 0.5)).toBe(4000);
  });
  it("treats attempt < 1 as first", () => expect(backoffDelay(0, cfg)).toBe(1000));
});
describe("isFinalAttempt", () => {
  it("flags the last permitted attempt", () => {
    expect(isFinalAttempt(0, 3)).toBe(false);
    expect(isFinalAttempt(1, 3)).toBe(false);
    expect(isFinalAttempt(2, 3)).toBe(true);
    expect(isFinalAttempt(0, 1)).toBe(true);
  });
});
describe("dedupeKey", () => {
  it("is deterministic and skips empty parts", () => {
    expect(dedupeKey("reminder", "b1", 60, "a@b.c")).toBe("reminder:b1:60:a@b.c");
    expect(dedupeKey("x", null, undefined, "")).toBe("x");
    expect(dedupeKey("a", "b")).not.toBe(dedupeKey("b", "a"));
  });
});
