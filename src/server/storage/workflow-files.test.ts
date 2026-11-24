import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db, pool, schema } from "../db";
import { assertStepFiles, cleanFileName, loadEmailAttachments, saveWorkflowFile, sniffFile } from "./workflow-files";

const run = randomUUID().slice(0, 8);
const A = `wf_${run}_a`, B = `wf_${run}_b`;
const pdf = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(200, 1)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50)]);
const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return (e as { code?: string }).code ?? (e as Error).message; } };

beforeAll(async () => {
  await db.insert(schema.users).values([{ id: A, name: "A", email: `${A}@example.test` }, { id: B, name: "B", email: `${B}@example.test` }]);
});
afterAll(async () => { await db.delete(schema.users).where(inArray(schema.users.id, [A, B])); await pool.end(); });

describe("file type detection (from the bytes, never the name)", () => {
  it("accepts PDF, images, text and office files", () => {
    expect(sniffFile(pdf, "x.pdf")?.mime).toBe("application/pdf");
    expect(sniffFile(png, "whatever.bin")?.mime).toBe("image/png");
    expect(sniffFile(Buffer.from("a,b\n1,2"), "t.csv")?.mime).toBe("text/csv");
    expect(sniffFile(Buffer.from([0x50, 0x4b, 3, 4, 0, 0]), "d.docx")?.ext).toBe("docx");
  });
  it("refuses executables, scripts, html, svg and bare zips, whatever they are called", () => {
    expect(sniffFile(Buffer.from("MZ\x90\x00"), "invoice.pdf")).toBeNull();
    expect(sniffFile(Buffer.from("<html><script>1</script>"), "a.txt")).toBeNull();
    expect(sniffFile(Buffer.from("<svg xmlns='x'/>"), "a.txt")).toBeNull();
    expect(sniffFile(Buffer.from("#!/bin/sh\nrm -rf /"), "a.sh")).toBeNull();
    expect(sniffFile(Buffer.from([0x50, 0x4b, 3, 4]), "a.zip")).toBeNull();
    expect(sniffFile(Buffer.from("PK\x03\x04"), "a.exe")).toBeNull();
  });
  it("cleans names: no path, no odd characters, forced extension", () => {
    expect(cleanFileName("..\..\evil/Q3 \"plan\".exe", "pdf")).toBe("Q3 plan.pdf");
    expect(cleanFileName("", "png")).toBe("attachment.png");
  });
});

describe("saving and attaching", () => {
  it("stores a file, and the worker loads it as base64 identical to the upload", async () => {
    const f = await saveWorkflowFile(A, "Welcome pack.pdf", pdf);
    expect(f).toMatchObject({ name: "Welcome pack.pdf", contentType: "application/pdf", size: pdf.length });
    const [att] = await loadEmailAttachments([f.id]);
    expect(att).toMatchObject({ filename: "Welcome pack.pdf", contentType: "application/pdf", encoding: "base64" });
    expect(Buffer.from(att!.content, "base64").equals(pdf)).toBe(true);
  });
  it("rejects empty, oversized and disallowed uploads", async () => {
    expect(await code(saveWorkflowFile(A, "e.pdf", Buffer.alloc(0)))).toBe("VALIDATION");
    expect(await code(saveWorkflowFile(A, "big.pdf", Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(5 * 1024 * 1024)])))).toBe("VALIDATION");
    expect(await code(saveWorkflowFile(A, "run.exe", Buffer.from("MZ....")))).toBe("VALIDATION");
  });
  it("only the owner may attach a file, at most 3 per step", async () => {
    const f = await saveWorkflowFile(A, "a.pdf", pdf);
    await expect(assertStepFiles(A, [f.id])).resolves.toBeUndefined();
    expect(await code(assertStepFiles(B, [f.id]))).toBe("FORBIDDEN");
    const four = await Promise.all([1, 2, 3, 4].map((n) => saveWorkflowFile(A, `f${n}.pdf`, pdf)));
    expect(await code(assertStepFiles(A, four.map((x) => x.id)))).toBe("VALIDATION");
  });
  it("a deleted file is skipped when sending instead of failing the email", async () => {
    expect(await loadEmailAttachments([randomUUID()])).toEqual([]);
  });
});
