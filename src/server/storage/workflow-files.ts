import { and, eq, inArray } from "drizzle-orm";
import { db as defaultDb, schema, type Db } from "../db";
import { AppError } from "../errors";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const MAX_FILES_PER_STEP = 3;
export const MAX_STEP_BYTES = 8 * 1024 * 1024;

type Kind = { ext: string; mime: string };
const startsWith = (b: Uint8Array, sig: number[], at = 0) => b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);

/**
 * What a file really is, from its first bytes (never the client's MIME type or file name).
 * Allowed: PDF, PNG, JPEG, GIF, WebP, plain text/CSV, and Office files (docx/xlsx/pptx, which are zip containers).
 * Refused: anything executable, script, HTML or SVG (they can run code in the recipient's mail client or browser).
 */
export function sniffFile(b: Uint8Array, fileName: string): Kind | null {
  if (startsWith(b, [0x25, 0x50, 0x44, 0x46, 0x2d])) return { ext: "pdf", mime: "application/pdf" };
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47])) return { ext: "png", mime: "image/png" };
  if (startsWith(b, [0xff, 0xd8, 0xff])) return { ext: "jpg", mime: "image/jpeg" };
  if (startsWith(b, [0x47, 0x49, 0x46, 0x38])) return { ext: "gif", mime: "image/gif" };
  if (startsWith(b, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, [0x57, 0x45, 0x42, 0x50], 8)) return { ext: "webp", mime: "image/webp" };
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) {
    const ext = fileName.toLowerCase().split(".").pop();
    const office: Record<string, string> = {
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    };
    return ext && office[ext] ? { ext, mime: office[ext]! } : null; // a bare .zip is not allowed
  }
  const ext = fileName.toLowerCase().split(".").pop();
  if (ext === "txt" || ext === "csv") {
    // text only: no NUL bytes, and it must not look like markup or a script
    const head = Buffer.from(b.slice(0, 4096));
    if (head.includes(0)) return null;
    if (/^\s*<(!doctype|html|svg|script|\?xml)/i.test(head.toString("utf8"))) return null;
    return { ext, mime: ext === "csv" ? "text/csv" : "text/plain" };
  }
  return null;
}

/** A safe display / attachment name: no path, no control characters, keeps the extension. */
export function cleanFileName(name: string, ext: string): string {
  const base = name.replace(/^.*[\/]/, "").replace(/[\u0000-\u001f"<>:|?*]/g, "").replace(/\s+/g, " ").trim().replace(/\.[^.]*$/, "").slice(0, 80) || "attachment";
  return `${base}.${ext}`;
}

export interface StoredFile { id: string; name: string; contentType: string; size: number }

export async function saveWorkflowFile(userId: string, fileName: string, data: Buffer, db: Db = defaultDb): Promise<StoredFile> {
  if (data.length === 0) throw new AppError("VALIDATION", "The file is empty.", 400);
  if (data.length > MAX_FILE_BYTES) throw new AppError("VALIDATION", "Files must be 5 MB or smaller.", 400);
  const kind = sniffFile(data, fileName);
  if (!kind) throw new AppError("VALIDATION", "Allowed files: PDF, PNG, JPEG, GIF, WebP, TXT, CSV, DOCX, XLSX, PPTX.", 400);
  const name = cleanFileName(fileName, kind.ext);
  const [row] = await db.insert(schema.workflowAttachments).values({ ownerUserId: userId, name, contentType: kind.mime, size: data.length, data })
    .returning({ id: schema.workflowAttachments.id });
  return { id: row!.id, name, contentType: kind.mime, size: data.length };
}

/** Metadata for files this user owns (used by the editor and to validate a step's attachment list). */
export async function listOwnedFiles(userId: string, ids: string[], db: Db = defaultDb): Promise<StoredFile[]> {
  if (!ids.length) return [];
  const a = schema.workflowAttachments;
  return db.select({ id: a.id, name: a.name, contentType: a.contentType, size: a.size }).from(a)
    .where(and(eq(a.ownerUserId, userId), inArray(a.id, ids)));
}

/** Throws unless every id is a file the user owns and the step stays within the count and size limits. */
export async function assertStepFiles(userId: string, ids: string[] | undefined, db: Db = defaultDb): Promise<void> {
  if (!ids?.length) return;
  const unique = [...new Set(ids)];
  if (unique.length > MAX_FILES_PER_STEP) throw new AppError("VALIDATION", `Attach at most ${MAX_FILES_PER_STEP} files to a step.`, 422);
  const files = await listOwnedFiles(userId, unique, db);
  if (files.length !== unique.length) throw new AppError("FORBIDDEN", "Unknown attachment", 403);
  if (files.reduce((n, f) => n + f.size, 0) > MAX_STEP_BYTES) throw new AppError("VALIDATION", "A step's attachments must total 8 MB or less.", 422);
}

/** Email-ready attachments (base64) for the worker. Missing files (deleted since) are skipped, never fatal. */
export async function loadEmailAttachments(ids: string[] | undefined, db: Db = defaultDb) {
  if (!ids?.length) return [];
  const a = schema.workflowAttachments;
  const rows = await db.select({ name: a.name, contentType: a.contentType, data: a.data }).from(a).where(inArray(a.id, ids.slice(0, MAX_FILES_PER_STEP)));
  return rows.map((r) => ({ filename: r.name, content: r.data.toString("base64"), contentType: r.contentType, encoding: "base64" as const }));
}
