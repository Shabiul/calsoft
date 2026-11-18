import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, pool, schema } from "@/server/db";
import { AppError } from "@/server/errors";
import { createEventType, deleteEventType, duplicateEventType, getEventType, listEventTypes, setEventTypeArchived, updateEventType } from "./event-types";
import { createSchedule, deleteSchedule, getSchedule, saveSchedule, setDefaultSchedule, deleteBlockedTime, createBlockedTime } from "./availability";
import { assertWithinPlan } from "./plan-limits";
import { findIntervalProblem } from "@/lib/validation/availability";

const run = randomUUID().slice(0, 8);
const U = { a: `t-a-${run}`, b: `t-b-${run}`, c: `t-c-${run}`, d: `t-d-${run}` };
const planId = `test-plan-${run}`; // small limits
const bigPlan = `test-big-${run}`;
const featPlan = `test-feat-${run}`;
let orgId: string;

const base = (over: Record<string, unknown> = {}) => ({
  title: "Intro call", slug: "intro", durationMinutes: 30, locationType: "google_meet", ...over,
});
const asErr = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as AppError; } throw new Error("expected rejection"); };

beforeAll(async () => {
  for (const [k, id] of Object.entries(U)) {
    await db.insert(schema.users).values({ id, name: `User ${k}`, email: `${id}@test.local` });
  }
  const [org] = await db.insert(schema.organizations).values({ name: `Org ${run}`, slug: `org-${run}`, planId: bigPlan }).returning();
  orgId = org.id;
  await db.insert(schema.organizationMembers).values([
    { organizationId: orgId, userId: U.a, role: "admin" },
    { organizationId: orgId, userId: U.b, role: "member" },
  ]);
  const all = { groupEvents: true, roundRobin: true, collective: true, payments: true };
  await db.insert(schema.subscriptionPlans).values([
    { id: planId, name: "Test small", limits: { maxEventTypes: 3, maxSchedules: 2, ...all } },
    { id: bigPlan, name: "Test big", limits: { maxEventTypes: -1, maxSchedules: -1, ...all } },
    { id: featPlan, name: "Test feat", limits: { maxEventTypes: -1, groupEvents: false, payments: false, roundRobin: false, collective: false } },
  ]);
  await db.insert(schema.subscriptions).values([
    { userId: U.a, planId: bigPlan, status: "active" }, { userId: U.b, planId: bigPlan, status: "active" },
    { userId: U.c, planId, status: "active" }, { userId: U.d, planId: featPlan, status: "active" },
  ]);
});

afterAll(async () => {
  await db.delete(schema.subscriptions).where(inArray(schema.subscriptions.planId, [planId, bigPlan, featPlan]));
  await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
  await db.delete(schema.subscriptionPlans).where(inArray(schema.subscriptionPlans.id, [planId, bigPlan, featPlan]));
  await db.delete(schema.users).where(inArray(schema.users.id, Object.values(U))); // cascades event types, schedules
  await pool.end();
});

describe("event type slug uniqueness", () => {
  it("rejects a duplicate slug for the same owner", async () => {
    await createEventType({ userId: U.a }, base());
    const e = await asErr(createEventType({ userId: U.a }, base({ title: "Other" })));
    expect(e.code).toBe("SLUG_TAKEN");
    expect(e.status).toBe(409);
  });
  it("allows the same slug for a different owner", async () => {
    const et = await createEventType({ userId: U.b }, base());
    expect(et.slug).toBe("intro");
  });
  it("frees the slug after soft delete", async () => {
    const et = await createEventType({ userId: U.a }, base({ slug: "temp" }));
    await deleteEventType({ userId: U.a }, et.id);
    const again = await createEventType({ userId: U.a }, base({ slug: "temp" }));
    expect(again.id).not.toBe(et.id);
  });
  it("rejects renaming onto an existing slug but allows keeping own slug", async () => {
    const x = await createEventType({ userId: U.a }, base({ slug: "x-event" }));
    const e = await asErr(updateEventType({ userId: U.a }, x.id, base({ slug: "intro" })));
    expect(e.code).toBe("SLUG_TAKEN");
    const ok = await updateEventType({ userId: U.a }, x.id, base({ slug: "x-event", title: "Renamed" }));
    expect(ok.title).toBe("Renamed");
  });
  it("validates slug format", async () => {
    const e = await asErr(createEventType({ userId: U.a }, base({ slug: "Bad Slug!" })));
    expect(e.code).toBe("VALIDATION");
  });
});

describe("authorization", () => {
  it("hides and forbids other users' event types", async () => {
    const [mine] = await listEventTypes({ userId: U.a });
    expect((await asErr(getEventType({ userId: U.b }, mine.id))).code).toBe("FORBIDDEN");
    expect((await asErr(updateEventType({ userId: U.b }, mine.id, base({ slug: "zzz" })))).code).toBe("FORBIDDEN");
    expect((await asErr(deleteEventType({ userId: U.b }, mine.id))).code).toBe("FORBIDDEN");
    expect((await asErr(duplicateEventType({ userId: U.b }, mine.id))).code).toBe("FORBIDDEN");
    expect((await asErr(getEventType({ userId: U.a }, "not-a-uuid"))).code).toBe("NOT_FOUND");
  });
  it("org: members cannot create, admins can; hosts must be members", async () => {
    const input = base({ slug: "team-call", organizationId: orgId, kind: "round_robin", hosts: [{ userId: U.a }, { userId: U.b }] });
    expect((await asErr(createEventType({ userId: U.b }, input))).code).toBe("FORBIDDEN");
    expect((await asErr(createEventType({ userId: U.c }, input))).code).toBe("FORBIDDEN");
    const bad = await asErr(createEventType({ userId: U.a }, { ...input, hosts: [{ userId: U.c }] }));
    expect(bad.code).toBe("VALIDATION");
    const et = await createEventType({ userId: U.a }, input);
    expect(et.hosts.map((h) => h.userId).sort()).toEqual([U.a, U.b].sort());
    // plain members can read but not manage
    expect((await getEventType({ userId: U.b }, et.id)).id).toBe(et.id);
    expect((await asErr(updateEventType({ userId: U.b }, et.id, input))).code).toBe("FORBIDDEN");
  });
  it("team kinds require an organization", async () => {
    const e = await asErr(createEventType({ userId: U.a }, base({ slug: "rr", kind: "collective" })));
    expect(e.code).toBe("VALIDATION");
  });
});

describe("duplicate, archive, questions", () => {
  it("duplicates fields, questions and gets a unique slug", async () => {
    const src = await createEventType({ userId: U.a }, base({
      slug: "src", title: "Source", bufferAfterMinutes: 10, color: "#112233",
      questions: [{ label: "Topic?", type: "dropdown", options: ["A", "B"], required: true }, { label: "Notes", type: "long_text" }],
      pageSettings: { headline: "Hello" },
    }));
    const d1 = await duplicateEventType({ userId: U.a }, src.id);
    const d2 = await duplicateEventType({ userId: U.a }, src.id);
    expect(d1.slug).toBe("src-copy");
    expect(d2.slug).toBe("src-copy-2");
    expect(d1.title).toBe("Source (copy)");
    expect(d1.bufferAfterMinutes).toBe(10);
    expect(d1.questions.map((q) => q.label)).toEqual(["Topic?", "Notes"]);
    expect(d1.questions[0].options).toEqual(["A", "B"]);
    expect(d1.questions[0].id).not.toBe(src.questions[0].id);
    expect(d1.pageSettings?.headline).toBe("Hello");
  });
  it("reorders questions and archives", async () => {
    const et = await createEventType({ userId: U.a }, base({ slug: "qs", questions: [{ label: "One", type: "short_text" }, { label: "Two", type: "email", required: true }] }));
    const [q1, q2] = et.questions;
    const up = await updateEventType({ userId: U.a }, et.id, base({ slug: "qs", questions: [{ id: q2.id, label: "Two", type: "email", required: true }, { id: q1.id, label: "One", type: "short_text" }] }));
    expect(up.questions.map((q) => q.label)).toEqual(["Two", "One"]);
    expect(up.questions[0].id).toBe(q2.id);
    await setEventTypeArchived({ userId: U.a }, et.id, true);
    expect((await listEventTypes({ userId: U.a })).some((e) => e.id === et.id)).toBe(false);
    expect((await listEventTypes({ userId: U.a }, { includeArchived: true })).some((e) => e.id === et.id)).toBe(true);
  });
  it("rejects option questions without options", async () => {
    const e = await asErr(createEventType({ userId: U.a }, base({ slug: "bad-q", questions: [{ label: "Pick", type: "radio" }] })));
    expect(e.code).toBe("VALIDATION");
  });
});

describe("plan limits", () => {
  it("blocks creation beyond maxEventTypes", async () => {
    for (const s of ["p1", "p2", "p3"]) await createEventType({ userId: U.c }, base({ slug: s }));
    const e = await asErr(createEventType({ userId: U.c }, base({ slug: "p4" })));
    expect(e.code).toBe("PLAN_LIMIT");
    expect(e.status).toBe(402);
    await expect(assertWithinPlan({ userId: U.c }, "maxEventTypes")).rejects.toBeInstanceOf(AppError);
    // archiving frees a slot; duplicates are also limited
    const [one] = await listEventTypes({ userId: U.c });
    await setEventTypeArchived({ userId: U.c }, one.id, true);
    await expect(assertWithinPlan({ userId: U.c }, "maxEventTypes")).resolves.toBeUndefined();
    // one-off links do not count
    const oneOff = await duplicateEventType({ userId: U.c }, (await listEventTypes({ userId: U.c }))[0].id, { oneOff: true });
    expect(oneOff.isOneOff).toBe(true);
  });
  it("is unlimited when the plan says -1", async () => {
    await expect(assertWithinPlan({ userId: U.b }, "maxEventTypes")).resolves.toBeUndefined();
  });
  it("enforces feature flags for kinds and payments", async () => {
    const g = await asErr(createEventType({ userId: U.d }, base({ slug: "grp", kind: "group", capacity: 5 })));
    expect(g.code).toBe("PLAN_FEATURE");
    const p = await asErr(createEventType({ userId: U.d }, base({ slug: "paid", priceAmount: 1000, priceCurrency: "usd", paymentProvider: "stripe" })));
    expect(p.code).toBe("PLAN_FEATURE");
    expect((await createEventType({ userId: U.d }, base({ slug: "free-one" }))).slug).toBe("free-one");
  });
});

describe("availability schedules", () => {
  it("rejects overlapping and inverted intervals (pure + service)", async () => {
    expect(findIntervalProblem([{ start: "09:00", end: "12:00" }, { start: "11:00", end: "14:00" }])).toMatch(/overlap/);
    expect(findIntervalProblem([{ start: "10:00", end: "09:00" }])).toMatch(/before/);
    expect(findIntervalProblem([{ start: "09:00", end: "12:00" }, { start: "12:00", end: "14:00" }])).toBeNull();
    const s = await createSchedule(U.a, { name: "Work", timeZone: "Europe/Berlin" });
    expect(s.isDefault).toBe(true);
    expect(s.rules).toHaveLength(5);
    const e1 = await asErr(saveSchedule(U.a, s.id, { name: "Work", timeZone: "Europe/Berlin", rules: [{ weekday: 1, start: "09:00", end: "12:00" }, { weekday: 1, start: "11:00", end: "13:00" }] }));
    expect(e1.code).toBe("VALIDATION");
    const e2 = await asErr(saveSchedule(U.a, s.id, { name: "Work", timeZone: "Nope/Zone", rules: [] }));
    expect(e2.code).toBe("VALIDATION");
    // stored rules unchanged after failed save
    expect((await getSchedule(U.a, s.id)).rules).toHaveLength(5);
  });
  it("saves multiple intervals and date overrides, sets default, protects ownership", async () => {
    const s = await createSchedule(U.a, { name: "Split", timeZone: "UTC", template: "empty" });
    const saved = await saveSchedule(U.a, s.id, {
      name: "Split", timeZone: "Asia/Kolkata",
      rules: [{ weekday: 2, start: "09:00", end: "12:00" }, { weekday: 2, start: "13:00", end: "17:00" }],
      overrides: [{ date: "2030-01-01", unavailable: true }, { date: "2030-01-02", intervals: [{ start: "10:00", end: "11:00" }, { start: "14:00", end: "15:00" }] }],
    });
    expect(saved.timeZone).toBe("Asia/Kolkata");
    expect(saved.rules).toEqual([{ weekday: 2, start: "09:00", end: "12:00" }, { weekday: 2, start: "13:00", end: "17:00" }]);
    expect(saved.overrides).toEqual([
      { date: "2030-01-01", unavailable: true, intervals: [] },
      { date: "2030-01-02", unavailable: false, intervals: [{ start: "10:00", end: "11:00" }, { start: "14:00", end: "15:00" }] },
    ]);
    const dupDate = await asErr(saveSchedule(U.a, s.id, { name: "Split", timeZone: "UTC", rules: [], overrides: [{ date: "2030-01-01", unavailable: true }, { date: "2030-01-01", unavailable: true }] }));
    expect(dupDate.code).toBe("VALIDATION");
    expect((await asErr(getSchedule(U.b, s.id))).code).toBe("FORBIDDEN");
    expect((await asErr(saveSchedule(U.b, s.id, { name: "x", timeZone: "UTC", rules: [] }))).code).toBe("FORBIDDEN");
    await setDefaultSchedule(U.a, s.id);
    const all = await db.select().from(schema.availabilitySchedules).where(eq(schema.availabilitySchedules.userId, U.a));
    expect(all.filter((x) => x.isDefault).map((x) => x.id)).toEqual([s.id]);
    // deleting the default promotes another schedule
    await deleteSchedule(U.a, s.id);
    const left = await db.select().from(schema.availabilitySchedules).where(eq(schema.availabilitySchedules.userId, U.a));
    expect(left).toHaveLength(1);
    expect(left[0].isDefault).toBe(true);
    expect((await asErr(deleteSchedule(U.a, left[0].id))).code).toBe("INVALID_STATE");
  });
  it("assigning another user's schedule to an event type is rejected", async () => {
    const theirs = await createSchedule(U.b, { name: "Theirs", timeZone: "UTC" });
    const e = await asErr(createEventType({ userId: U.a }, base({ slug: "sched-x", scheduleId: theirs.id })));
    expect(e.code).toBe("VALIDATION");
  });
  it("blocked time validates range and ownership", async () => {
    const e = await asErr(createBlockedTime(U.a, { startsAt: "2030-02-02T10:00:00Z", endsAt: "2030-02-01T10:00:00Z" }));
    expect(e.code).toBe("VALIDATION");
    const b = await createBlockedTime(U.a, { startsAt: "2030-02-01T10:00:00Z", endsAt: "2030-02-05T10:00:00Z", reason: "Vacation" });
    expect((await asErr(deleteBlockedTime(U.b, b.id))).code).toBe("FORBIDDEN");
    await deleteBlockedTime(U.a, b.id);
  });
});
