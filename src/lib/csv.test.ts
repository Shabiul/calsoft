import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv";

describe("csv", () => {
  it("quotes commas, quotes and newlines", () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(null)).toBe("");
  });
  it("neutralises spreadsheet formulas", () => {
    for (const f of ["=SUM(A1)", "+1", "-1+2", "@cmd"]) expect(csvCell(f).startsWith("'")).toBe(true);
  });
  it("formats dates as ISO and joins rows with CRLF", () => {
    expect(toCsv(["when", "who"], [[new Date("2030-01-01T00:00:00Z"), "x"]])).toBe("when,who\r\n2030-01-01T00:00:00.000Z,x\r\n");
  });
});
