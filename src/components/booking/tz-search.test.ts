import { describe, expect, it } from "vitest";
import { describeZone } from "./TimezoneSelect";
import { allTimeZones } from "./format";
import { zoneCountry } from "./tz-countries";

const search = (q: string) => allTimeZones().map(describeZone).filter((z) => z.hay.includes(q.toLowerCase())).map((z) => z.id);

describe("time zone search", () => {
  it("finds zones by country name, nickname and city", () => {
    expect(search("germany")).toContain("Europe/Berlin");
    expect(search("uk")).toContain("Europe/London");
    expect(search("usa")).toContain("America/New_York");
    expect(search("dubai")).toContain("Asia/Dubai");
    expect(search("india").some((id) => id === "Asia/Kolkata" || id === "Asia/Calcutta")).toBe(true);
  });

  it("every zone in the list has a country, except UTC/Etc", () => {
    expect(allTimeZones().filter((id) => !zoneCountry(id) && !/^(UTC|Etc\/|GMT)/.test(id))).toEqual([]);
  });

  it("shows current city names for old aliases", () => {
    expect(describeZone("Asia/Calcutta")).toMatchObject({ city: "Kolkata", place: "India" });
    expect(describeZone("Europe/Kiev")).toMatchObject({ city: "Kyiv", place: "Ukraine" });
  });
});
