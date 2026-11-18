"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth-session";
import { AppError } from "@/server/errors";
import { runSafe } from "@/server/workflows/run-action";
import { createForm, deleteForm, slugify, updateForm } from "@/server/services/routing-forms";

const uuid = z.string().uuid();
const id = (v: unknown) => {
  const r = uuid.safeParse(v);
  if (!r.success) throw new AppError("VALIDATION", "Invalid id", 422);
  return r.data;
};

export async function createFormAction(name: string) {
  const user = await requireUser();
  return runSafe(async () => {
    const base = z.string().trim().min(1, "Name is required").max(120).parse(name);
    // pick a free slug by suffixing -2, -3 ... on conflict
    const slug = slugify(base);
    for (let i = 1; i <= 20; i++) {
      try {
        const f = await createForm(user.id, { name: base, slug: i === 1 ? slug : `${slug}-${i}` });
        revalidatePath("/dashboard/routing-forms");
        return { id: f.id };
      } catch (e) { if (!(e instanceof AppError && e.status === 409)) throw e; }
    }
    throw new AppError("CONFLICT", "Could not find a free slug", 409);
  });
}

export async function saveFormAction(formId: string, input: { name: string; slug: string; config: unknown }) {
  const user = await requireUser();
  return runSafe(async () => {
    await updateForm(user.id, id(formId), {
      name: z.string().max(120).parse(input.name), slug: z.string().max(60).parse(input.slug), config: input.config,
    });
    revalidatePath("/dashboard/routing-forms");
    revalidatePath(`/dashboard/routing-forms/${formId}`);
    return null;
  });
}

export async function deleteFormAction(formId: string) {
  const user = await requireUser();
  return runSafe(async () => {
    await deleteForm(user.id, id(formId));
    revalidatePath("/dashboard/routing-forms");
    return null;
  });
}
