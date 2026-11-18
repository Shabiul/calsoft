import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { requireUserApi } from "@/lib/auth-session";
import { db, schema } from "@/server/db";
import { isAppError } from "@/server/errors";
import { deleteAvatarByUrl, saveAvatar, MAX_AVATAR_BYTES } from "@/server/storage/avatars";
import { limitOr429 } from "@/server/ratelimit";

function fail(e: unknown) {
  if (isAppError(e)) return NextResponse.json(e.toJSON(), { status: e.status });
  console.error("[avatar]", e);
  return NextResponse.json({ error: { code: "INTERNAL", message: "Upload failed" } }, { status: 500 });
}

export async function POST(req: Request) {
  try {
    const user = await requireUserApi();
    const limited = await limitOr429(req, "avatar-upload", 10, 60);
    if (limited) return limited;
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > MAX_AVATAR_BYTES + 64 * 1024) return NextResponse.json({ error: { code: "VALIDATION", message: "Image must be 2 MB or smaller." } }, { status: 413 });
    const file = (await req.formData()).get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: { code: "VALIDATION", message: "No file provided." } }, { status: 400 });
    const url = await saveAvatar(user.id, new Uint8Array(await file.arrayBuffer()));
    const [old] = await db.select({ image: schema.users.image }).from(schema.users).where(eq(schema.users.id, user.id));
    await db.update(schema.users).set({ image: url, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
    await deleteAvatarByUrl(old?.image);
    return NextResponse.json({ url });
  } catch (e) { return fail(e); }
}

export async function DELETE() {
  try {
    const user = await requireUserApi();
    const [old] = await db.select({ image: schema.users.image }).from(schema.users).where(eq(schema.users.id, user.id));
    await db.update(schema.users).set({ image: null, updatedAt: new Date() }).where(eq(schema.users.id, user.id));
    await deleteAvatarByUrl(old?.image);
    return NextResponse.json({ ok: true });
  } catch (e) { return fail(e); }
}
