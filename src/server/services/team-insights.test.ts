import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { DateTime } from "luxon";
import { db, pool, schema } from "../db";
import { AppError } from "../errors";
import { computeHeatmap, getTeamInsights } from "./team-insights";

const at = (iso: string) => DateTime.fromISO(iso) as DateTime<true>;
const ref = at("2030-03-06T12:00:00Z"); // a Wednesday
const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e instanceof AppError ? e.code : (e as Error).message; } };

describe("computeHeatmap", () => {
  it("marks the working hours of one person in their own zone", () => {
    const h = computeHeatmap([[{ timeZone: "UTC", weekday: 1, startTime: "09:00:00", endTime: "12:00:00" }]], "UTC", ref);
    expect(h[1]!.slice(8, 13)).toEqual([0, 1, 1, 1, 0]);
    expect(h[2]!.every((n) => n === 0)).toBe(true);
  });
  it("converts a schedule into the viewer's zone (London 9-17 in winter is 10-18 in Lagos, UTC+1)", () => {
    const h = computeHeatmap([[{ timeZone: "Europe/London", weekday: 1, startTime: "09:00", endTime: "17:00" }]], "Africa/Lagos", at("2030-01-09T12:00:00Z"));
    expect(h[1]!.indexOf(1)).toBe(10);
    expect(h[1]!.lastIndexOf(1)).toBe(17);
  });
  it("counts people once per hour and adds them up", () => {
    const rule = { timeZone: "UTC", weekday: 3, startTime: "08:00", endTime: "10:00" };
    const h = computeHeatmap([[rule, { ...rule, startTime: "09:00", endTime: "11:00" }], [rule]], "UTC", ref);
    expect(h[3]!.slice(8, 11)).toEqual([2, 2, 1]);
  });
  it("shifts a rule onto the next day when the viewer's zone is ahead of the schedule's", () => {
    const h = computeHeatmap([[{ timeZone: "UTC", weekday: 1, startTime: "22:00", endTime: "23:00" }]], "Asia/Tokyo", ref); // UTC+9: 07:00 Tuesday
    expect(h[2]![7]).toBe(1);
    expect(h[1]!.every((n) => n === 0)).toBe(true);
  });
});

describe("getTeamInsights", () => {
  const run = randomUUID().slice(0, 8);
  const ids = { owner: `ti_${run}_o`, tl: `ti_${run}_t`, rep: `ti_${run}_r`, other: `ti_${run}_x`, plain: `ti_${run}_p` };
  let org = "";
  beforeAll(async () => {
    await db.insert(schema.users).values(Object.values(ids).map((id) => ({ id, name: id, email: `${id}@example.test`, timeZone: "UTC" })));
    const [o] = await db.insert(schema.organizations).values({ name: `Ti ${run}`, slug: `ti-${run}` }).returning();
    org = o!.id;
    await db.insert(schema.organizationMembers).values([
      { organizationId: org, userId: ids.owner, role: "owner" }, { organizationId: org, userId: ids.tl, role: "team_lead" },
      { organizationId: org, userId: ids.rep, role: "member", managerUserId: ids.tl }, { organizationId: org, userId: ids.other, role: "member" },
      { organizationId: org, userId: ids.plain, role: "member" },
    ]);
    for (const id of [ids.rep, ids.other]) {
      const [s] = await db.insert(schema.availabilitySchedules).values({ userId: id, name: "Working hours", timeZone: "UTC", isDefault: true }).returning();
      await db.insert(schema.availabilityRules).values({ scheduleId: s!.id, weekday: 1, startTime: "09:00", endTime: "10:00" });
    }
  });
  afterAll(async () => {
    await db.delete(schema.organizations).where(inArray(schema.organizations.id, [org]));
    await db.delete(schema.users).where(inArray(schema.users.id, Object.values(ids)));
    await pool.end();
  });

  it("owners see the whole team; team leads only their reports; members are refused", async () => {
    const all = await getTeamInsights(ids.owner, org, "UTC");
    expect(all.people).toBe(5);
    expect(all.heatmap[1]![9]).toBe(2);
    const tl = await getTeamInsights(ids.tl, org, "UTC");
    expect(tl.people).toBe(2); // themselves + their report
    expect(tl.heatmap[1]![9]).toBe(1);
    expect(tl.workload.map((w) => w.userId).sort()).toEqual([ids.tl, ids.rep].sort());
    expect(await code(getTeamInsights(ids.plain, org, "UTC"))).toBe("FORBIDDEN");
  });
  it("falls back to UTC for an invalid viewer zone", async () => {
    expect((await getTeamInsights(ids.owner, org, "Not/AZone")).viewerZone).toBe("UTC");
  });
});
