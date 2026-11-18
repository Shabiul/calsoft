import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { apiRoute, requireUuid } from "@/server/api/handler";
import { contactTenant, serializeContact } from "@/server/api/resources";
import { db, schema } from "@/server/db";
import { AppError } from "@/server/errors";

const { contacts } = schema;
type P = { id: string };

async function load(c: { key: Parameters<typeof contactTenant>[0]; params: P }) {
  const id = requireUuid(c.params.id, "Contact");
  const [row] = await db.select().from(contacts).where(and(eq(contacts.id, id), contactTenant(c.key))).limit(1);
  if (!row) throw new AppError("NOT_FOUND", "Contact not found", 404);
  return row;
}

export const GET = apiRoute<P>({ scope: "contacts:read" }, async (c) => serializeContact(await load(c)));

const patchBody = z.object({
  name: z.string().trim().max(200).nullish(), phone: z.string().trim().max(50).nullish(), time_zone: z.string().trim().max(100).nullish(),
}).strict();

export const PATCH = apiRoute<P>({ scope: "contacts:write" }, async (c) => {
  const cur = await load(c);
  const b = await c.body(patchBody);
  const [row] = await db.update(contacts).set({
    ...(b.name !== undefined && { name: b.name }), ...(b.phone !== undefined && { phone: b.phone }),
    ...(b.time_zone !== undefined && { timeZone: b.time_zone }), updatedAt: new Date(),
  }).where(eq(contacts.id, cur.id)).returning();
  c.setAudit("contact.updated", { type: "contact", id: cur.id });
  return serializeContact(row);
});

export const DELETE = apiRoute<P>({ scope: "contacts:write" }, async (c) => {
  const cur = await load(c);
  await db.delete(contacts).where(eq(contacts.id, cur.id));
  c.setAudit("contact.deleted", { type: "contact", id: cur.id });
  return new Response(null, { status: 204 });
});
