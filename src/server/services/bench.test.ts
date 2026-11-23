import { describe, it, expect } from "vitest";
import { nextStep } from "./bench";

const now = new Date("2030-03-01T12:00:00Z");
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const at = (days: number, stage = 0, status = "active") => nextStep({ status, lastActiveAt: daysAgo(days), bench: stage ? { stage } : null }, now);

describe("bench timeline", () => {
  it("warns at 14 and 18 days, once each, benches at 20", () => {
    expect(at(13)).toBeNull();
    expect(at(14)).toBe("warn_user");
    expect(at(15, 1)).toBeNull(); // already warned
    expect(at(18, 1)).toBe("warn_manager");
    expect(at(19, 2)).toBeNull();
    expect(at(20, 2)).toBe("bench");
    expect(at(25)).toBe("bench"); // missed warnings (worker down) never block benching
  });
  it("closes the account 60 days after benching, not before", () => {
    const benched = (benchedDaysAgo: number) =>
      nextStep({ status: "benched", lastActiveAt: daysAgo(benchedDaysAgo + 20), bench: { stage: 3, benchedAt: daysAgo(benchedDaysAgo).toISOString() } }, now);
    expect(benched(59)).toBeNull();
    expect(benched(60)).toBe("close");
  });
});
