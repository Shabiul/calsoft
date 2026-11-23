import { and, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import { DateTime } from "luxon";
import { db as defaultDb, schema, type Db } from "@/server/db";
import { AppError } from "@/server/errors";
import { validateUsername } from "@/lib/username";
import { checkUsername } from "./username";
import { deleteAvatarByUrl } from "@/server/storage/avatars";
import { cancelBooking } from "./booking";

const { users, sessions, bookings, bookingEvents } = schema;

export const profileSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(100),
  username: z.string().trim().min(1, "Username is required"),
  bio: z.string().trim().max(500).optional().or(z.literal("")),
  phone: z.string().trim().max(32).regex(/^[+()\-.\s\d]*$/, "Invalid phone number").optional().or(z.literal("")),
  country: z.string().trim().length(2).optional().or(z.literal("")),
  language: z.string().trim().min(2).max(10),
  timeZone: z.string().refine((z) => DateTime.local().setZone(z).isValid, "Unknown time zone"),
  dateFormat: z.enum(["MM/dd/yyyy", "dd/MM/yyyy", "yyyy-MM-dd"]),
  timeFormat: z.enum(["12h", "24h"]),
});
export type ProfileInput = z.infer<typeof profileSchema>;

export async function updateProfile(userId: string, raw: unknown, db: Db = defaultDb) {
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AppError("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid input", 400,
      parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  }
  const p = parsed.data;
  const v = validateUsername(p.username);
  if (!v.ok) throw new AppError("VALIDATION", v.message, 400, [{ path: "username", message: v.message }]);
  const avail = await checkUsername(v.username, userId, db);
  if (!avail.available) throw new AppError("CONFLICT", avail.message ?? "Username unavailable", 409, [{ path: "username", message: avail.message ?? "Username unavailable" }]);
  await db.update(users).set({
    name: p.name, username: v.username, bio: p.bio || null, phone: p.phone || null, country: p.country || null,
    language: p.language, timeZone: p.timeZone, dateFormat: p.dateFormat, timeFormat: p.timeFormat, updatedAt: new Date(),
  }).where(eq(users.id, userId));
  return { username: v.username };
}

/** GDPR-style export of everything we hold about the user (hosted bookings, event types, contacts, profile). */
export async function exportUserData(userId: string, db: Db = defaultDb) {
  const [profile] = await db.select({
    id: users.id, name: users.name, email: users.email, username: users.username, phone: users.phone, bio: users.bio, country: users.country,
    language: users.language, timeZone: users.timeZone, dateFormat: users.dateFormat, timeFormat: users.timeFormat, createdAt: users.createdAt,
  }).from(users).where(eq(users.id, userId));
  if (!profile) throw new AppError("NOT_FOUND", "User not found", 404);
  const [eventTypeRows, contactRows, bookingRows, scheduleRows] = await Promise.all([
    db.select().from(schema.eventTypes).where(eq(schema.eventTypes.ownerUserId, userId)),
    db.select().from(schema.contacts).where(eq(schema.contacts.ownerUserId, userId)),
    db.select().from(bookings).where(eq(bookings.hostUserId, userId)),
    db.select().from(schema.availabilitySchedules).where(eq(schema.availabilitySchedules.userId, userId)),
  ]);
  const ids = bookingRows.map((b) => b.id);
  const inviteeRows = ids.length ? await db.select().from(schema.invitees).where(inArray(schema.invitees.bookingId, ids)) : [];
  return {
    exportedAt: new Date().toISOString(), profile, eventTypes: eventTypeRows, availabilitySchedules: scheduleRows, contacts: contactRows,
    bookings: bookingRows.map(({ manageTokenHash: _m, ...b }) => ({ ...b, invitees: inviteeRows.filter((i) => i.bookingId === b.id) })),
  };
}

/**
 * Soft-deletes the account: disables sign-in, frees the username, revokes sessions, cancels future hosted bookings.
 * Historic bookings are retained (they reference the user) but the profile is anonymised.
 */
export async function deleteAccount(userId: string, db: Db = defaultDb) {
  const [u] = await db.select({ image: users.image }).from(users).where(eq(users.id, userId));
  const now = new Date();
  // Cancel future hosted bookings through the normal path BEFORE the profile is anonymised: invitees get the cancellation email,
  // the calendar events / meeting links are removed and webhooks fire. (A raw row update would leave them with a live invite.)
  const upcoming = await db.select({ id: bookings.id }).from(bookings)
    .where(and(eq(bookings.hostUserId, userId), gt(bookings.startsAt, now), inArray(bookings.status, ["confirmed", "pending_payment", "pending_confirmation"])));
  for (const b of upcoming) {
    try { await cancelBooking({ bookingId: b.id, actor: "host", actorId: userId, reason: "The host closed their account." }); }
    catch (e) { console.error("[deleteAccount] could not cancel booking", b.id, e instanceof Error ? e.message : e); } // the safety net below still cancels it
  }
  await db.transaction(async (tx) => {
    const future = await tx.select({ id: bookings.id }).from(bookings)
      .where(and(eq(bookings.hostUserId, userId), gt(bookings.startsAt, now), inArray(bookings.status, ["confirmed", "pending_payment", "pending_confirmation"])));
    if (future.length) {
      const fids = future.map((f) => f.id);
      await tx.update(bookings).set({ status: "cancelled", cancelledAt: now, cancelReason: "Host account deleted", cancelledBy: "host", updatedAt: now })
        .where(inArray(bookings.id, fids));
      await tx.insert(bookingEvents).values(fids.map((id) => ({ bookingId: id, type: "cancelled", actor: userId, data: { reason: "host_account_deleted" } })));
    }
    await tx.update(users).set({
      deletedAt: now, status: "deleted", username: null, image: null, bio: null, phone: null,
      name: "Deleted user", email: `deleted+${userId}@deleted.invalid`, updatedAt: now,
    }).where(eq(users.id, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
    await tx.delete(schema.accounts).where(eq(schema.accounts.userId, userId));
    await tx.update(schema.eventTypes).set({ isActive: false, deletedAt: now }).where(eq(schema.eventTypes.ownerUserId, userId));
  });
  await deleteAvatarByUrl(u?.image);
}
