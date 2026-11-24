import { NextResponse } from "next/server";
import { requireUserApi } from "@/lib/auth-session";
import { isAppError } from "@/server/errors";
import { limitOr429 } from "@/server/ratelimit";
import { MAX_FILE_BYTES, saveWorkflowFile } from "@/server/storage/workflow-files";

/** Upload a file for a workflow email step (multipart, field "file"). Returns the stored file's id, name and size. */
export async function POST(req: Request) {
  try {
    const user = await requireUserApi();
    const limited = await limitOr429(req, "workflow-file-upload", 20, 60);
    if (limited) return limited;
    if (Number(req.headers.get("content-length") ?? 0) > MAX_FILE_BYTES + 64 * 1024) return NextResponse.json({ message: "Files must be 5 MB or smaller." }, { status: 413 });
    const f = (await req.formData()).get("file");
    if (!(f instanceof File)) return NextResponse.json({ message: "Choose a file." }, { status: 400 });
    return NextResponse.json(await saveWorkflowFile(user.id, f.name, Buffer.from(await f.arrayBuffer())));
  } catch (e) {
    if (isAppError(e)) return NextResponse.json({ message: e.message }, { status: e.status });
    console.error("[workflow-file]", e);
    return NextResponse.json({ message: "Upload failed" }, { status: 500 });
  }
}
