import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { AppError } from "@/server/errors";

export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
export const AVATAR_URL_PREFIX = "/api/files/avatars/";

export function uploadRoot(): string {
  return path.resolve(/*turbopackIgnore: true*/ process.env.UPLOAD_DIR || "./storage/uploads");
}
const avatarDir = () => path.join(uploadRoot(), "avatars");

/** Detect image type from magic bytes (never trust client MIME / filename). */
export function sniffImage(buf: Uint8Array): { ext: "png" | "jpg" | "webp" | "gif"; mime: string } | null {
  const b = buf;
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { ext: "png", mime: "image/png" };
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return { ext: "webp", mime: "image/webp" };
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return { ext: "gif", mime: "image/gif" };
  return null;
}

export function validateAvatar(buf: Uint8Array): { ext: string; mime: string } {
  if (buf.length === 0) throw new AppError("VALIDATION", "The file is empty.", 400);
  if (buf.length > MAX_AVATAR_BYTES) throw new AppError("VALIDATION", "Image must be 2 MB or smaller.", 400);
  const t = sniffImage(buf);
  if (!t) throw new AppError("VALIDATION", "Only PNG, JPEG, WebP or GIF images are allowed.", 400);
  return t;
}

export async function saveAvatar(userId: string, buf: Uint8Array): Promise<string> {
  const { ext } = validateAvatar(buf);
  await mkdir(avatarDir(), { recursive: true });
  const name = `${userId.replace(/[^a-zA-Z0-9_-]/g, "")}-${randomBytes(6).toString("hex")}.${ext}`;
  await writeFile(path.join(avatarDir(), name), buf);
  return AVATAR_URL_PREFIX + name;
}

export function isSafeAvatarName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+\.(png|jpg|webp|gif)$/.test(name);
}

export async function readAvatar(name: string): Promise<{ data: Buffer; mime: string } | null> {
  if (!isSafeAvatarName(name)) return null;
  try {
    const data = await readFile(path.join(avatarDir(), name));
    const t = sniffImage(data);
    return t ? { data, mime: t.mime } : null;
  } catch { return null; }
}

export async function deleteAvatarByUrl(url: string | null | undefined): Promise<void> {
  if (!url || !url.startsWith(AVATAR_URL_PREFIX)) return;
  const name = url.slice(AVATAR_URL_PREFIX.length);
  if (!isSafeAvatarName(name)) return;
  await unlink(path.join(avatarDir(), name)).catch(() => undefined);
}
