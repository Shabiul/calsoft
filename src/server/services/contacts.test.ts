/** Integration tests against the dev Postgres with isolated fixtures. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, pool, schema } from "../db";
import {
  addNote, createContact, csvCell, deleteNote, exportContactsCsv, findDuplicateGroups, getContactDetail, listContacts, mergeContacts, updateNote,
} from "./contacts";

const run = randomUUID().slice(0, 8);
const A = `t_${run}_ca`, B = `t_${run}_cb`;
let ev = "";
const bookingIds: string[] = [];
const c: Record<string, string> = {};

async function mkBooking(host: string, contactId: string, start: string, status: "confirmed" | "completed" | "cancelled", collective = false) {
  const s = new Date(start);
  const [b] = await db.insert(schema.bookings).values({
    eventTypeId: ev, hostUserId: host, startsAt: s, endsAt: new Date(s.getTime() + 1_800_000), blockStart: s, blockEnd: new Date(s.getTime() + 1_800_000),
    status, inviteeTimeZone: "UTC", hostTimeZone: "UTC", externalEventIds: collective ? { collectiveOf: randomUUID() } : {},
  }).returning();
  bookingIds.push(b!.id);
  await db.insert(schema.invitees).values({ bookingId: b!.id, contactId, name: "x", email: "x@example.test" });
  await db.insert(schema.bookingEvents).values({ bookingId: b!.id, type: "created", actor: "invitee" });
  return b!;
}

beforeAll(async () => {
  for (const id of [A, B]) await db.insert(schema.users).values({ id, name: `User ${id}`, email: `${id}@example.test`, timeZone: "UTC" });
  ev = (await db.insert(schema.eventTypes).values({ ownerUserId: A, slug: `e-${run}`, title: "Chat", durationMinutes: 30 }).returning())[0]!.id;
  const ins = async (k: string, owner: string, email: string, name: string | null, phone: string | null = null) => {
    c[k] = (await db.insert(schema.contacts).values({ ownerUserId: owner, email, name, phone }).returning())[0]!.id;
  };
  await ins("ann", A, `ann-${run}@example.test`, "Ann Archer");
  await ins("bob", A, `bob-${run}@example.test`, "Bob 100%_Smith");
  await ins("dupL", A, `Dup-${run}@example.test`, null, "555-1");        // mixed-case legacy rows
  await ins("dupU", A, `dup-${run}@example.test`, "Dup Person");
  await ins("bTheirs", B, `ann-${run}@example.test`, "Other tenant Ann");
  const future = new Date(Date.now() + 5 * 86_400_000).toISOString();
  await mkBooking(A, c.ann!, "2020-01-01T10:00:00Z", "completed");
  await mkBooking(A, c.ann!, future, "confirmed");
  await mkBooking(A, c.ann!, "2020-02-01T10:00:00Z", "confirmed", true); // collective link: hidden
  await mkBooking(A, c.dupL!, "2020-03-01T10:00:00Z", "completed");
  await mkBooking(A, c.dupU!, "2020-03-02T10:00:00Z", "cancelled");
});

afterAll(async () => {
  await db.delete(schema.bookings).where(inArray(schema.bookings.id, bookingIds));
  await db.delete(schema.contacts).where(inArray(schema.contacts.ownerUserId, [A, B]));
  await db.delete(schema.eventTypes).where(eq(schema.eventTypes.id, ev));
  await db.delete(schema.users).where(inArray(schema.users.id, [A, B]));
  await pool.end();
});


describe("contacts list", () => {
  it("is scoped to the owner", async () => {
    const a = await listContacts(A);
    expect(a.total).toBe(4);
    expect(a.rows.every((r) => r.email.endsWith("@example.test"))).toBe(true);
    const b = await listContacts(B);
    expect(b.total).toBe(1);
    expect(b.rows[0]!.name).toBe("Other tenant Ann");
  });
  it("searches case-insensitively and escapes LIKE wildcards", async () => {
    expect((await listContacts(A, { q: "ARCHER" })).total).toBe(1);
    expect((await listContacts(A, { q: "100%_" })).total).toBe(1);
    expect((await listContacts(A, { q: "%" })).total).toBe(1); // only Bob literally contains %
    expect((await listContacts(A, { q: `bob-${run}` })).total).toBe(1);
  });
  it("filters and aggregates (collective links not counted)", async () => {
    const up = await listContacts(A, { filter: "upcoming" });
    expect(up.rows.map((r) => r.id)).toEqual([c.ann]);
    expect(up.rows[0]!.bookingCount).toBe(2);
    expect(up.rows[0]!.nextMeetingAt).not.toBeNull();
    expect(up.rows[0]!.lastMeetingAt).toContain("2020-01-01");
    expect((await listContacts(A, { filter: "never" })).rows.map((r) => r.id)).toEqual([c.bob]);
    expect((await listContacts(A, { filter: "booked" })).total).toBe(3);
  });
  it("paginates and sorts", async () => {
    const p1 = await listContacts(A, { pageSize: 3, page: 1, sort: "email" });
    const p2 = await listContacts(A, { pageSize: 3, page: 2, sort: "email" });
    expect(p1.rows).toHaveLength(3);
    expect(p2.rows).toHaveLength(1);
    expect(p1.total).toBe(4);
    expect((await listContacts(A, { sort: "bookings" })).rows[0]!.id).toBe(c.ann);
  });
});

describe("contact detail & notes", () => {
  it("splits upcoming/past, hides collective links, includes history", async () => {
    const d = await getContactDetail(A, c.ann!);
    expect(d.upcoming).toHaveLength(1);
    expect(d.past).toHaveLength(1);
    expect(d.history.length).toBeGreaterThan(0);
  });
  it("denies cross-tenant access", async () => {
    await expect(getContactDetail(B, c.ann!)).rejects.toMatchObject({ status: 404 });
    await expect(addNote(B, c.ann!, "hi")).rejects.toMatchObject({ status: 404 });
  });
  it("notes CRUD with validation and permissions", async () => {
    await expect(addNote(A, c.ann!, "   ")).rejects.toMatchObject({ status: 422 });
    const n = await addNote(A, c.ann!, "  Prefers mornings ");
    expect(n.body).toBe("Prefers mornings");
    await updateNote(A, n.id, "Prefers afternoons");
    expect((await getContactDetail(A, c.ann!)).notes[0]).toMatchObject({ body: "Prefers afternoons", canDelete: true });
    await expect(deleteNote(B, n.id)).rejects.toMatchObject({ status: 404 });
    await deleteNote(A, n.id);
    expect((await getContactDetail(A, c.ann!)).notes).toHaveLength(0);
  });
});

describe("dedupe / merge", () => {
  it("createContact dedupes case-insensitively and fills blanks only", async () => {
    const r = await createContact(A, { email: `  ANN-${run}@Example.test `, name: "Ignored", phone: "123" });
    expect(r.created).toBe(false);
    expect(r.contact.id).toBe(c.ann);
    expect(r.contact.name).toBe("Ann Archer");
    expect(r.contact.phone).toBe("123");
    const n = await createContact(A, { email: `New-${run}@example.test` });
    expect(n.created).toBe(true);
    expect(n.contact.email).toBe(`new-${run}@example.test`);
    await expect(createContact(A, { email: "nope" })).rejects.toMatchObject({ status: 422 });
  });
  it("finds duplicate groups and merges them", async () => {
    const groups = await findDuplicateGroups(A);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.contacts.map((x) => x.id).sort()).toEqual([c.dupL, c.dupU].sort());
    await addNote(A, c.dupL!, "note on dup");
    await expect(mergeContacts(A, c.dupU!, [c.ann!])).rejects.toMatchObject({ status: 422 });
    await expect(mergeContacts(B, c.dupU!, [c.dupL!])).rejects.toMatchObject({ status: 404 });
    const m = await mergeContacts(A, c.dupU!, [c.dupL!]);
    expect(m.mergedCount).toBe(1);
    expect(m.contact).toMatchObject({ id: c.dupU, email: `dup-${run}@example.test`, name: "Dup Person", phone: "555-1" });
    const d = await getContactDetail(A, c.dupU!);
    expect(d.past).toHaveLength(2);
    expect(d.notes).toHaveLength(1);
    expect(await findDuplicateGroups(A)).toHaveLength(0);
    expect((await db.select().from(schema.contacts).where(eq(schema.contacts.id, c.dupL!)))).toHaveLength(0);
  });
});

describe("csv", () => {
  it("quotes and neutralises formulas", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell(null)).toBe("");
  });
  it("exports only the caller's contacts", async () => {
    const csv = await exportContactsCsv(A, { q: run });
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("Email,Name,Phone,Time zone,Bookings,Last meeting (UTC),Next meeting (UTC),Created (UTC)");
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(csv).not.toContain("Other tenant");
  });
});

