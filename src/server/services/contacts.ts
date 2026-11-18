import { and, asc, desc, eq, inArray, or, sql, type SQL } from "drizzle-orm";
import { DateTime } from "luxon";
import { db as defaultDb, schema, type Db } from "@/server/db";
import { AppError } from "@/server/errors";

const { contacts, contactNotes, invitees, bookings, bookingEvents, eventTypes, organizationMembers, users } = schema;

export type ContactFilter = "all" | "upcoming" | "booked" | "never";
export type ContactSort = "recent" | "name" | "email" | "bookings";

export const normEmail = (e: string) => e.trim().toLowerCase();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Orgs where the user may see every member's contacts. */
async function adminOrgIds(userId: string, db: Db): Promise<string[]> {
  const rows = await db.select({ id: organizationMembers.organizationId }).from(organizationMembers)
    .where(and(eq(organizationMembers.userId, userId), inArray(organizationMembers.role, ["owner", "admin"])));
  return rows.map((r) => r.id);
}

/** Server-side scoping: own contacts + contacts of orgs the user owns/admins. */
async function scope(userId: string, db: Db): Promise<SQL> {
  const orgs = await adminOrgIds(userId, db);
  const own = eq(contacts.ownerUserId, userId);
  return orgs.length ? (or(own, inArray(contacts.organizationId, orgs)) as SQL) : own;
}

const escLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

// invitee→booking aggregates, excluding collective-linked duplicate rows
const bookingAgg = {
  total: sql<number>`(select count(*)::int from invitee i join booking b on b.id = i.booking_id where i.contact_id = "contact"."id" and not (b.external_event_ids ? 'collectiveOf'))`,
  last: sql<Date | null>`(select max(b.starts_at) from invitee i join booking b on b.id = i.booking_id where i.contact_id = "contact"."id" and not (b.external_event_ids ? 'collectiveOf') and b.starts_at <= now() and b.status not in ('cancelled','expired','rescheduled','pending_payment','pending_confirmation'))`,
  next: sql<Date | null>`(select min(b.starts_at) from invitee i join booking b on b.id = i.booking_id where i.contact_id = "contact"."id" and not (b.external_event_ids ? 'collectiveOf') and b.starts_at > now() and b.status in ('confirmed','pending_payment','pending_confirmation'))`,
};

export interface ContactListItem {
  id: string; email: string; name: string | null; phone: string | null; timeZone: string | null;
  createdAt: string; bookingCount: number; lastMeetingAt: string | null; nextMeetingAt: string | null;
}
export interface ContactListQuery { q?: string; filter?: ContactFilter; sort?: ContactSort; page?: number; pageSize?: number }

function listWhere(base: SQL, q?: string, filter: ContactFilter = "all"): SQL {
  const conds: SQL[] = [base];
  const term = q?.trim().slice(0, 100);
  if (term) {
    const like = `%${escLike(term)}%`;
    conds.push(or(sql`${contacts.email} ilike ${like}`, sql`coalesce(${contacts.name}, '') ilike ${like}`, sql`coalesce(${contacts.phone}, '') ilike ${like}`) as SQL);
  }
  if (filter === "upcoming") conds.push(sql`${bookingAgg.next} is not null`);
  else if (filter === "booked") conds.push(sql`${bookingAgg.total} > 0`);
  else if (filter === "never") conds.push(sql`${bookingAgg.total} = 0`);
  return and(...conds) as SQL;
}

export async function listContacts(userId: string, query: ContactListQuery = {}, db: Db = defaultDb) {
  const pageSize = Math.min(Math.max(query.pageSize ?? 25, 1), 200);
  const page = Math.max(query.page ?? 1, 1);
  const where = listWhere(await scope(userId, db), query.q, query.filter);
  const order = {
    recent: [desc(contacts.updatedAt)], name: [asc(sql`lower(coalesce(${contacts.name}, ${contacts.email}))`)],
    email: [asc(sql`lower(${contacts.email})`)], bookings: [desc(bookingAgg.total), asc(contacts.email)],
  }[query.sort ?? "recent"];
  const [[c], rows] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(contacts).where(where),
    db.select({
      id: contacts.id, email: contacts.email, name: contacts.name, phone: contacts.phone, timeZone: contacts.timeZone, createdAt: contacts.createdAt,
      bookingCount: bookingAgg.total, last: bookingAgg.last, next: bookingAgg.next,
    }).from(contacts).where(where).orderBy(...order).limit(pageSize).offset((page - 1) * pageSize),
  ]);
  const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
  return {
    total: c?.n ?? 0, page, pageSize,
    rows: rows.map((r): ContactListItem => ({
      id: r.id, email: r.email, name: r.name, phone: r.phone, timeZone: r.timeZone, createdAt: r.createdAt.toISOString(),
      bookingCount: r.bookingCount, lastMeetingAt: iso(r.last), nextMeetingAt: iso(r.next),
    })),
  };
}

async function loadScoped(userId: string, id: string, db: Db) {
  const [row] = await db.select().from(contacts).where(and(eq(contacts.id, id), await scope(userId, db))).limit(1);
  if (!row) throw new AppError("NOT_FOUND", "Contact not found", 404);
  return row;
}

export interface ContactBooking {
  id: string; startsAt: string; endsAt: string; status: string; title: string; color: string | null; hostName: string; meetingUrl: string | null;
}
export interface ContactDetail {
  contact: { id: string; email: string; name: string | null; phone: string | null; timeZone: string | null; createdAt: string; updatedAt: string };
  upcoming: ContactBooking[]; past: ContactBooking[];
  notes: { id: string; body: string; createdAt: string; authorId: string | null; authorName: string | null; canDelete: boolean }[];
  history: { id: string; type: string; createdAt: string; bookingId: string; title: string }[];
}

export async function getContactDetail(userId: string, id: string, db: Db = defaultDb, now = new Date()): Promise<ContactDetail> {
  const c = await loadScoped(userId, id, db);
  const bk = await db.select({
    id: bookings.id, startsAt: bookings.startsAt, endsAt: bookings.endsAt, status: bookings.status, meetingUrl: bookings.meetingUrl,
    title: eventTypes.title, color: eventTypes.color, hostName: users.name,
  }).from(invitees).innerJoin(bookings, eq(bookings.id, invitees.bookingId))
    .innerJoin(eventTypes, eq(eventTypes.id, bookings.eventTypeId)).innerJoin(users, eq(users.id, bookings.hostUserId))
    .where(and(eq(invitees.contactId, c.id), sql`not (${bookings.externalEventIds} ? 'collectiveOf')`))
    .orderBy(desc(bookings.startsAt)).limit(500);
  const dto = (b: (typeof bk)[number]): ContactBooking => ({ ...b, startsAt: b.startsAt.toISOString(), endsAt: b.endsAt.toISOString() });
  const upcoming = bk.filter((b) => b.startsAt > now && (b.status === "confirmed" || b.status === "pending_payment" || b.status === "pending_confirmation")).reverse().map(dto);
  const upIds = new Set(upcoming.map((b) => b.id));
  const past = bk.filter((b) => !upIds.has(b.id)).map(dto);

  const notes = await db.select({
    id: contactNotes.id, body: contactNotes.body, createdAt: contactNotes.createdAt, authorId: contactNotes.authorId, authorName: users.name,
  }).from(contactNotes).leftJoin(users, eq(users.id, contactNotes.authorId)).where(eq(contactNotes.contactId, c.id)).orderBy(desc(contactNotes.createdAt));

  const ids = bk.map((b) => b.id);
  const history = ids.length
    ? await db.select({ id: bookingEvents.id, type: bookingEvents.type, createdAt: bookingEvents.createdAt, bookingId: bookingEvents.bookingId, title: eventTypes.title })
      .from(bookingEvents).innerJoin(bookings, eq(bookings.id, bookingEvents.bookingId)).innerJoin(eventTypes, eq(eventTypes.id, bookings.eventTypeId))
      .where(inArray(bookingEvents.bookingId, ids)).orderBy(desc(bookingEvents.createdAt)).limit(100)
    : [];
  return {
    contact: { id: c.id, email: c.email, name: c.name, phone: c.phone, timeZone: c.timeZone, createdAt: c.createdAt.toISOString(), updatedAt: c.updatedAt.toISOString() },
    upcoming, past,
    notes: notes.map((n) => ({ ...n, createdAt: n.createdAt.toISOString(), canDelete: n.authorId === userId || c.ownerUserId === userId })),
    history: history.map((h) => ({ ...h, createdAt: h.createdAt.toISOString() })),
  };
}

// ───────── create / update / notes

function cleanFields(p: { name?: string | null; phone?: string | null; timeZone?: string | null }) {
  const name = p.name?.trim() || null, phone = p.phone?.trim() || null, timeZone = p.timeZone?.trim() || null;
  if (name && name.length > 200) throw new AppError("VALIDATION", "Name is too long", 422);
  if (phone && phone.length > 40) throw new AppError("VALIDATION", "Phone is too long", 422);
  if (timeZone && !DateTime.local().setZone(timeZone).isValid) throw new AppError("VALIDATION", "Invalid time zone", 422);
  return { name, phone, timeZone };
}

/** Manual add. Deduplicates by (owner, lower(email)): an existing contact is returned (and blanks filled) instead of a second row. */
export async function createContact(userId: string, input: { email: string; name?: string; phone?: string; timeZone?: string }, db: Db = defaultDb) {
  const email = normEmail(input.email ?? "");
  if (!EMAIL_RE.test(email)) throw new AppError("VALIDATION", "A valid email is required", 422);
  const f = cleanFields(input);
  const [existing] = await db.select().from(contacts).where(and(eq(contacts.ownerUserId, userId), sql`lower(${contacts.email}) = ${email}`)).limit(1);
  if (existing) {
    const [row] = await db.update(contacts).set({
      name: existing.name || f.name, phone: existing.phone || f.phone, timeZone: existing.timeZone || f.timeZone, updatedAt: new Date(),
    }).where(eq(contacts.id, existing.id)).returning();
    return { contact: row!, created: false };
  }
  const [row] = await db.insert(contacts).values({ ownerUserId: userId, email, ...f }).onConflictDoNothing().returning();
  if (!row) { // lost a race
    const [again] = await db.select().from(contacts).where(and(eq(contacts.ownerUserId, userId), eq(contacts.email, email))).limit(1);
    return { contact: again!, created: false };
  }
  return { contact: row, created: true };
}

export async function updateContact(userId: string, id: string, input: { name?: string | null; phone?: string | null; timeZone?: string | null }, db: Db = defaultDb) {
  await loadScoped(userId, id, db);
  const f = cleanFields(input);
  const [row] = await db.update(contacts).set({ ...f, updatedAt: new Date() }).where(eq(contacts.id, id)).returning();
  return row!;
}

export async function addNote(userId: string, contactId: string, body: string, db: Db = defaultDb) {
  await loadScoped(userId, contactId, db);
  const text = body?.trim();
  if (!text) throw new AppError("VALIDATION", "Note cannot be empty", 422);
  if (text.length > 5000) throw new AppError("VALIDATION", "Note is too long (max 5000 characters)", 422);
  const [row] = await db.insert(contactNotes).values({ contactId, authorId: userId, body: text }).returning();
  return row!;
}

async function loadNote(userId: string, noteId: string, db: Db) {
  const [n] = await db.select().from(contactNotes).where(eq(contactNotes.id, noteId)).limit(1);
  if (!n) throw new AppError("NOT_FOUND", "Note not found", 404);
  const c = await loadScoped(userId, n.contactId, db); // 404 if no access to the contact
  if (n.authorId !== userId && c.ownerUserId !== userId) throw new AppError("FORBIDDEN", "You can only change your own notes", 403);
  return n;
}

export async function updateNote(userId: string, noteId: string, body: string, db: Db = defaultDb) {
  await loadNote(userId, noteId, db);
  const text = body?.trim();
  if (!text) throw new AppError("VALIDATION", "Note cannot be empty", 422);
  if (text.length > 5000) throw new AppError("VALIDATION", "Note is too long (max 5000 characters)", 422);
  const [row] = await db.update(contactNotes).set({ body: text }).where(eq(contactNotes.id, noteId)).returning();
  return row!;
}

export async function deleteNote(userId: string, noteId: string, db: Db = defaultDb) {
  await loadNote(userId, noteId, db);
  await db.delete(contactNotes).where(eq(contactNotes.id, noteId));
}

// ───────── dedupe / merge

export interface DuplicateGroup { key: string; contacts: { id: string; email: string; name: string | null; bookingCount: number; createdAt: string }[] }

/** Groups of contacts sharing (owner, lower(email)) — possible only with legacy/mixed-case data, but cheap to detect. */
export async function findDuplicateGroups(userId: string, db: Db = defaultDb): Promise<DuplicateGroup[]> {
  const rows = await db.select({
    id: contacts.id, email: contacts.email, name: contacts.name, createdAt: contacts.createdAt, owner: contacts.ownerUserId,
    n: sql<number>`(select count(*)::int from invitee i where i.contact_id = ${contacts.id})`,
  }).from(contacts).where(eq(contacts.ownerUserId, userId)).orderBy(asc(contacts.createdAt));
  const groups = new Map<string, DuplicateGroup>();
  for (const r of rows) {
    const key = normEmail(r.email);
    const g = groups.get(key) ?? { key, contacts: [] };
    g.contacts.push({ id: r.id, email: r.email, name: r.name, bookingCount: r.n, createdAt: r.createdAt.toISOString() });
    groups.set(key, g);
  }
  return [...groups.values()].filter((g) => g.contacts.length > 1);
}

/**
 * Merge `duplicateIds` into `primaryId`: re-points invitees and notes, fills blank profile fields on the primary,
 * normalizes its email to lowercase, then removes the duplicates. All contacts must belong to the same owner.
 */
export async function mergeContacts(userId: string, primaryId: string, duplicateIds: string[], db: Db = defaultDb) {
  const dups = [...new Set(duplicateIds)].filter((d) => d !== primaryId);
  if (!dups.length) throw new AppError("VALIDATION", "Select at least one other contact to merge", 422);
  if (dups.length > 50) throw new AppError("VALIDATION", "Too many contacts to merge at once", 422);
  return db.transaction(async (tx) => {
    const primary = await loadScoped(userId, primaryId, tx as unknown as Db);
    const rows = await tx.select().from(contacts).where(and(inArray(contacts.id, dups), await scope(userId, tx as unknown as Db)));
    if (rows.length !== dups.length) throw new AppError("NOT_FOUND", "Contact not found", 404);
    for (const r of rows) {
      if (r.ownerUserId !== primary.ownerUserId || r.organizationId !== primary.organizationId) {
        throw new AppError("VALIDATION", "Only contacts with the same owner can be merged", 422);
      }
      if (normEmail(r.email) !== normEmail(primary.email)) throw new AppError("VALIDATION", "Only contacts with the same email can be merged", 422);
    }
    await tx.update(invitees).set({ contactId: primary.id }).where(inArray(invitees.contactId, dups));
    await tx.update(contactNotes).set({ contactId: primary.id }).where(inArray(contactNotes.contactId, dups));
    const pick = <K extends "name" | "phone" | "timeZone">(k: K) => primary[k] || rows.find((r) => r[k])?.[k] || null;
    await tx.delete(contacts).where(inArray(contacts.id, dups));
    const [merged] = await tx.update(contacts).set({
      email: normEmail(primary.email), name: pick("name"), phone: pick("phone"), timeZone: pick("timeZone"), updatedAt: new Date(),
    }).where(eq(contacts.id, primary.id)).returning();
    return { contact: merged!, mergedCount: dups.length };
  });
}

// ───────── CSV

/** RFC 4180 quoting + spreadsheet formula-injection guard. */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (header: string[], rows: unknown[][]) => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

export async function exportContactsCsv(userId: string, query: Pick<ContactListQuery, "q" | "filter" | "sort"> = {}, db: Db = defaultDb): Promise<string> {
  const out: ContactListItem[] = [];
  for (let page = 1; page <= 100; page++) {
    const r = await listContacts(userId, { ...query, page, pageSize: 200 }, db);
    out.push(...r.rows);
    if (out.length >= r.total || r.rows.length === 0) break;
  }
  return toCsv(
    ["Email", "Name", "Phone", "Time zone", "Bookings", "Last meeting (UTC)", "Next meeting (UTC)", "Created (UTC)"],
    out.map((c) => [c.email, c.name, c.phone, c.timeZone, c.bookingCount, c.lastMeetingAt, c.nextMeetingAt, c.createdAt]),
  );
}
