import { and, desc, eq, ilike, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { apiRoute, created, decodeCursor, encodeCursor, page, paginationQuery } from "@/server/api/handler";
import { contactTenant, serializeContact } from "@/server/api/resources";
import { db, schema } from "@/server/db";
import { AppError } from "@/server/errors";

const { contacts } = schema;
const escLike = (s: string) => s.replace(/[\\%_]/g, "\\$&");

export const GET = apiRoute({ scope: "contacts:read" }, async (c) => {
  const q = c.query(paginationQuery.extend({ email: z.string().email().optional(), search: z.string().trim().min(1).max(100).optional() }));
  const conds: SQL[] = [contactTenant(c.key)];
  if (q.email) conds.push(eq(sql`lower(${contacts.email})`, q.email.toLowerCase()));
  if (q.search) conds.push(or(ilike(contacts.email, `%${escLike(q.search)}%`), ilike(contacts.name, `%${escLike(q.search)}%`)) as SQL);
  const cur = decodeCursor(q.cursor);
  if (cur) conds.push(or(lt(contacts.createdAt, new Date(cur.t)), and(eq(contacts.createdAt, new Date(cur.t)), lt(contacts.id, cur.id))) as SQL);
  const rows = await db.select().from(contacts).where(and(...conds)).orderBy(desc(contacts.createdAt), desc(contacts.id)).limit(q.limit + 1);
  const hasMore = rows.length > q.limit;
  const slice = rows.slice(0, q.limit);
  const last = slice[slice.length - 1];
  return page(slice.map(serializeContact), hasMore, hasMore && last ? encodeCursor(last.createdAt, last.id) : null);
});

const contactBody = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().max(200).nullish(),
  phone: z.string().trim().max(50).nullish(),
  time_zone: z.string().trim().max(100).nullish(),
});

export const POST = apiRoute({ scope: "contacts:write" }, async (c) => {
  const b = await c.body(contactBody);
  const [dup] = await db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.ownerUserId, c.key.userId), eq(contacts.email, b.email))).limit(1);
  if (dup) throw new AppError("CONFLICT", "A contact with this email already exists", 409, { id: dup.id });
  const [row] = await db.insert(contacts).values({
    ownerUserId: c.key.userId, organizationId: c.key.organizationId, email: b.email, name: b.name ?? null, phone: b.phone ?? null, timeZone: b.time_zone ?? null,
  }).returning();
  c.setAudit("contact.created", { type: "contact", id: row.id });
  return created(serializeContact(row));
});
