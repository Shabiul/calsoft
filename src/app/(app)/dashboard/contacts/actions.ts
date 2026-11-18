"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth-session";
import { AppError } from "@/server/errors";
import { runSafe } from "@/server/workflows/run-action";
import { addNote, createContact, deleteNote, mergeContacts, updateContact, updateNote } from "@/server/services/contacts";

const uuid = z.string().uuid();
const id = (v: unknown) => {
  const r = uuid.safeParse(v);
  if (!r.success) throw new AppError("VALIDATION", "Invalid id", 422);
  return r.data;
};
const refresh = (contactId?: string) => {
  revalidatePath("/dashboard/contacts");
  if (contactId) revalidatePath(`/dashboard/contacts/${contactId}`);
};

export async function createContactAction(input: { email: string; name?: string; phone?: string; timeZone?: string }) {
  const user = await requireUser();
  return runSafe(async () => {
    const r = await createContact(user.id, z.object({
      email: z.string().max(254), name: z.string().max(200).optional(), phone: z.string().max(40).optional(), timeZone: z.string().max(64).optional(),
    }).parse(input));
    refresh();
    return { id: r.contact.id, created: r.created };
  });
}

export async function updateContactAction(contactId: string, input: { name?: string; phone?: string; timeZone?: string }) {
  const user = await requireUser();
  return runSafe(async () => {
    await updateContact(user.id, id(contactId), z.object({ name: z.string().max(200).optional(), phone: z.string().max(40).optional(), timeZone: z.string().max(64).optional() }).parse(input));
    refresh(contactId);
    return null;
  });
}

export async function addNoteAction(contactId: string, body: string) {
  const user = await requireUser();
  return runSafe(async () => {
    await addNote(user.id, id(contactId), z.string().max(5000).parse(body));
    refresh(contactId);
    return null;
  });
}
export async function updateNoteAction(contactId: string, noteId: string, body: string) {
  const user = await requireUser();
  return runSafe(async () => {
    await updateNote(user.id, id(noteId), z.string().max(5000).parse(body));
    refresh(contactId);
    return null;
  });
}
export async function deleteNoteAction(contactId: string, noteId: string) {
  const user = await requireUser();
  return runSafe(async () => {
    await deleteNote(user.id, id(noteId));
    refresh(contactId);
    return null;
  });
}

export async function mergeContactsAction(primaryId: string, duplicateIds: string[]) {
  const user = await requireUser();
  return runSafe(async () => {
    const r = await mergeContacts(user.id, id(primaryId), z.array(uuid).max(50).parse(duplicateIds));
    refresh();
    return { mergedCount: r.mergedCount };
  });
}
