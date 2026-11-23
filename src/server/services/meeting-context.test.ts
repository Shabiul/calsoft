/** Real-DB test: meeting context from the "Schedule meeting" form and from personal context links. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, pool, schema } from "../db";
import { getAvailableSlots } from "../scheduling/slots";
import { createBooking, rescheduleBooking, setBookingEventHook } from "./booking";
import { createContextLink, getBookingDetail, listScheduled, scheduleMeeting } from "./scheduled";

const run = randomUUID().slice(0, 8);
const uid = (n: string) => `mc_${run}_${n}`;
setBookingEventHook(() => {});
const userIds: string[] = [], eventIds: string[] = [];
let orgId = "", HOST = "", SALES = "", OTHER = "", teamEvent = "";

async function mkUser(n: string) {
  const id = uid(n);
  await db.insert(schema.users).values({ id, name: n, email: `${id}@example.test`, timeZone: "UTC" });
  const [s] = await db.insert(schema.availabilitySchedules).values({ userId: id, name: "w", timeZone: "UTC", isDefault: true }).returning();
  await db.insert(schema.availabilityRules).values([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ scheduleId: s.id, weekday, startTime: "08:00", endTime: "20:00" })));
  userIds.push(id);
  return id;
}
const slots = () => getAvailableSlots({ eventTypeId: teamEvent, from: new Date(Date.now() + 3600_000), to: new Date(Date.now() + 3 * 86_400_000), inviteeTimeZone: "UTC" });
const row = async (id: string) => (await db.select().from(schema.bookings).where(eq(schema.bookings.id, id)))[0]!;
const inv = (n: string) => ({ name: `P ${n}`, email: `p-${n}-${run}@example.test`, timeZone: "UTC" });

beforeAll(async () => {
  [HOST, SALES, OTHER] = await Promise.all([mkUser("host"), mkUser("sales"), mkUser("other")]);
  const [org] = await db.insert(schema.organizations).values({ name: `M ${run}`, slug: `m-${run}` }).returning();
  orgId = org.id;
  await db.insert(schema.organizationMembers).values([
    { organizationId: orgId, userId: HOST, role: "owner" }, { organizationId: orgId, userId: SALES, role: "member" }, { organizationId: orgId, userId: OTHER, role: "member" },
  ]);
  // Team round robin with HOST as the only host: SALES schedules meetings for HOST (SDR -> account exec).
  const [e] = await db.insert(schema.eventTypes).values({ organizationId: orgId, slug: `rr-${run}`, title: `RR ${run}`, kind: "round_robin", minNoticeMinutes: 0, maxHorizonDays: 30 }).returning();
  await db.insert(schema.eventHosts).values({ eventTypeId: e.id, userId: HOST });
  teamEvent = e.id; eventIds.push(e.id);
});

afterAll(async () => {
  setBookingEventHook(null);
  await db.delete(schema.bookings).where(inArray(schema.bookings.eventTypeId, eventIds));
  await db.delete(schema.eventTypes).where(inArray(schema.eventTypes.id, eventIds));
  await db.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await pool.end();
});

describe("meeting context", () => {
  let scheduled = "";
  it("a salesperson scheduling for a teammate attaches context they and the host can see, other members cannot", async () => {
    const s = await slots();
    scheduled = (await scheduleMeeting(SALES, { eventTypeId: teamEvent, startsAt: s[1].startsAt, timeZone: "UTC", invitee: inv("a"), context: "  Wants SSO; budget approved  " })).bookingId;
    const b = await row(scheduled);
    expect(b.hostUserId).toBe(HOST);
    expect(b.hostNotes).toBe("Wants SSO; budget approved");
    expect(b.scheduledByUserId).toBe(SALES);
    expect((await getBookingDetail(SALES, scheduled)).hostNotes).toBe("Wants SSO; budget approved");
    expect((await getBookingDetail(HOST, scheduled)).hostNotes).toBe("Wants SSO; budget approved");
    expect((await listScheduled(SALES, { tab: "upcoming" })).rows.map((r) => r.id)).toContain(scheduled);
    await expect(getBookingDetail(OTHER, scheduled)).rejects.toMatchObject({ status: 404 });
  });

  it("a scheduler who leaves the team loses access to the meetings they scheduled", async () => {
    const [m] = await db.select().from(schema.organizationMembers).where(eq(schema.organizationMembers.userId, SALES));
    await db.delete(schema.organizationMembers).where(eq(schema.organizationMembers.id, m.id));
    try {
      await expect(getBookingDetail(SALES, scheduled)).rejects.toMatchObject({ status: 404 });
      expect((await listScheduled(SALES, { tab: "upcoming" })).rows.map((r) => r.id)).not.toContain(scheduled);
    } finally {
      await db.insert(schema.organizationMembers).values({ organizationId: orgId, userId: SALES, role: "member" });
    }
  });

  it("keeps the context when the meeting is rescheduled", async () => {
    const s = await slots();
    const moved = await rescheduleBooking({ bookingId: scheduled, newStartsAt: s[6].startsAt, actor: "host" });
    const b = await row(moved.booking.id);
    expect(b.hostNotes).toBe("Wants SSO; budget approved");
    expect(b.scheduledByUserId).toBe(SALES);
  });

  it("a context link attaches its notes to the first booking only, and checks the event type", async () => {
    await expect(createContextLink(SALES, teamEvent, "   ")).rejects.toMatchObject({ code: "VALIDATION" });
    const token = await createContextLink(SALES, teamEvent, "Met at the expo, interested in API");
    const s = await slots();
    const first = await createBooking({ eventTypeId: teamEvent, startsAt: s[10].startsAt, invitee: inv("b"), contextToken: token });
    expect((await row(first.booking.id))).toMatchObject({ hostNotes: "Met at the expo, interested in API", scheduledByUserId: SALES });
    const second = await createBooking({ eventTypeId: teamEvent, startsAt: s[14].startsAt, invitee: inv("c"), contextToken: token });
    expect((await row(second.booking.id))).toMatchObject({ hostNotes: null, scheduledByUserId: null });
    const bogus = await createBooking({ eventTypeId: teamEvent, startsAt: s[18].startsAt, invitee: inv("d"), contextToken: "x".repeat(24) });
    expect((await row(bogus.booking.id)).hostNotes).toBeNull();
  });
});
