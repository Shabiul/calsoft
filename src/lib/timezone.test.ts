import { describe, expect, it } from "vitest";
import { isValidTimeZone, normalizeTimeZone } from "./timezone";

describe("normalizeTimeZone", () => {
  it("passes IANA ids through untouched", () => {
    for (const tz of ["Asia/Kolkata", "America/New_York", "Asia/Kathmandu", "Europe/Helsinki", "UTC"]) expect(normalizeTimeZone(tz)).toBe(tz);
  });
  it("maps Windows zone names (Outlook/Exchange) to IANA ids", () => {
    expect(normalizeTimeZone("FLE Standard Time")).toBe("Europe/Kiev");
    expect(normalizeTimeZone("India Standard Time")).toBe("Asia/Kolkata");
    expect(normalizeTimeZone("Nepal Standard Time")).toBe("Asia/Kathmandu");
    expect(normalizeTimeZone("Eastern Standard Time")).toBe("America/New_York");
    expect(normalizeTimeZone("Pacific Standard Time")).toBe("America/Los_Angeles");
    expect(normalizeTimeZone("W. Europe Standard Time")).toBe("Europe/Berlin");
    expect(normalizeTimeZone("AUS Eastern Standard Time")).toBe("Australia/Sydney");
    expect(normalizeTimeZone("UTC")).toBe("UTC");
  });
  it("is case- and whitespace-insensitive for Windows names", () => {
    expect(normalizeTimeZone("  fle standard time ")).toBe("Europe/Kiev");
  });
  it("rejects names it cannot place instead of guessing", () => {
    for (const bad of ["", "   ", "Mars/Olympus", "Nowhere Standard Time", "EST5EDTX", "<script>"]) expect(normalizeTimeZone(bad)).toBeNull();
  });
  it("every mapped result is a zone the runtime accepts", () => {
    for (const w of ["Dateline Standard Time", "Line Islands Standard Time", "Samoa Standard Time", "Chatham Islands Standard Time", "Lord Howe Standard Time", "Myanmar Standard Time"]) {
      const tz = normalizeTimeZone(w);
      expect(tz && isValidTimeZone(tz)).toBe(true);
    }
  });
});
