import { describe, expect, it } from "vitest";
import { RESERVED_USERNAMES, slugifyUsername, usernameCandidates, validateUsername } from "./username";

describe("validateUsername", () => {
  it("accepts and normalizes valid names", () => {
    expect(validateUsername("  Jane-Doe_1 ")).toEqual({ ok: true, username: "jane-doe_1" });
  });
  it("rejects bad length", () => {
    expect(validateUsername("ab")).toMatchObject({ ok: false, reason: "length" });
    expect(validateUsername("a".repeat(31))).toMatchObject({ ok: false, reason: "length" });
  });
  it("rejects bad format", () => {
    for (const bad of ["-abc", "abc-", "a b c", "ab!c", "a--b", "a__b", "ünï"]) {
      expect(validateUsername(bad)).toMatchObject({ ok: false, reason: "format" });
    }
  });
  it("rejects reserved names, case-insensitively", () => {
    for (const r of ["login", "Dashboard", "API", "booking", "admin", "embed", "signup"]) {
      expect(validateUsername(r)).toMatchObject({ ok: false, reason: "reserved" });
    }
    expect(RESERVED_USERNAMES.has("login")).toBe(true);
  });
});

describe("suggestions", () => {
  it("slugifies names and accents", () => {
    expect(slugifyUsername("José Núñez")).toBe("jose-nunez");
    expect(slugifyUsername("A")).toBe("auser");
    expect(slugifyUsername("admin")).toBe("admin-1");
  });
  it("produces valid unique candidates", () => {
    const c = usernameCandidates("Jane Doe", 6, () => 0.5);
    expect(c.length).toBeGreaterThan(2);
    expect(new Set(c).size).toBe(c.length);
    for (const x of c) expect(validateUsername(x).ok).toBe(true);
    expect(c[0]).toBe("jane-doe");
  });
});
