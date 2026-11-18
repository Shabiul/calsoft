import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/server/db";
import { bookings, eventTypes, invitees, payments, users } from "@/server/db/schema";
import type { BookingContext } from "./types";

export async function loadBookingContext(bookingId: string): Promise<BookingContext | null> {
  const [row] = await db
    .select({ b: bookings, e: eventTypes, h: users })
    .from(bookings)
    .innerJoin(eventTypes, eq(eventTypes.id, bookings.eventTypeId))
    .innerJoin(users, eq(users.id, bookings.hostUserId))
    .where(eq(bookings.id, bookingId))
    .limit(1);
  if (!row) return null;
  const [inv] = await db.select().from(invitees)
    .where(and(eq(invitees.bookingId, bookingId), isNull(invitees.cancelledAt)))
    .orderBy(asc(invitees.createdAt)).limit(1);
  const fallbackInv = inv ?? (await db.select().from(invitees).where(eq(invitees.bookingId, bookingId)).orderBy(asc(invitees.createdAt)).limit(1))[0];
  if (!fallbackInv) return null;
  let series: BookingContext["series"] = null;
  if (row.b.seriesId) {
    const rows = await db.select({ startsAt: bookings.startsAt, endsAt: bookings.endsAt, status: bookings.status }).from(bookings)
      .where(and(eq(bookings.seriesId, row.b.seriesId), sql`not (${bookings.externalEventIds} ? 'collectiveOf')`, sql`${bookings.status} not in ('rescheduled')`))
      .orderBy(asc(bookings.startsAt));
    series = rows;
  }
  const [pay] = await db.select().from(payments).where(eq(payments.bookingId, bookingId)).orderBy(desc(payments.createdAt)).limit(1);
  return {
    booking: {
      id: row.b.id, status: row.b.status, startsAt: row.b.startsAt, endsAt: row.b.endsAt,
      inviteeTimeZone: row.b.inviteeTimeZone, hostTimeZone: row.b.hostTimeZone,
      meetingUrl: row.b.meetingUrl, locationType: row.b.locationType,
      cancelReason: row.b.cancelReason, cancelledBy: row.b.cancelledBy, seriesId: row.b.seriesId,
    },
    eventType: {
      id: row.e.id, title: row.e.title, description: row.e.description, locationValue: row.e.locationValue,
      cancellationPolicy: row.e.cancellationPolicy, priceAmount: row.e.priceAmount, priceCurrency: row.e.priceCurrency,
    },
    host: { id: row.h.id, name: row.h.name, email: row.h.email },
    invitee: { name: fallbackInv.name, email: fallbackInv.email },
    series,
    payment: pay ? { amount: pay.amount, currency: pay.currency, status: pay.status } : null,
  };
}
