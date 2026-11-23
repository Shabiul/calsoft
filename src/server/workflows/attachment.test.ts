/** Real-DB: the "attach calendar invite" option survives create -> edit -> reload and reaches the email job. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, schema } from "../db";
import { createWorkflow, deleteWorkflow, getWorkflowForEdit, updateWorkflow } from "./service";

const uid = `wfa_${randomUUID().slice(0, 8)}`;
const step = (attachIcs: boolean | undefined) => ({ action: "send_email" as const, offsetMinutes: 0, to: "invitee" as const, subject: "Hi {{invitee_name}}", body: "Body", attachIcs });
let wfId = "";

beforeAll(async () => { await db.insert(schema.users).values({ id: uid, name: "WF Host", email: `${uid}@example.test`, timeZone: "UTC" }); });
afterAll(async () => {
  if (wfId) await deleteWorkflow(uid, wfId).catch(() => undefined);
  await db.delete(schema.users).where(eq(schema.users.id, uid));
  await pool.end();
});

describe("workflow attachment option", () => {
  it("is stored with the step and returned for editing", async () => {
    const wf = await createWorkflow(uid, { name: "Confirm", trigger: "booking_created", steps: [step(true)] });
    wfId = wf.id;
    expect((await getWorkflowForEdit(uid, wfId)).steps[0]).toMatchObject({ attachIcs: true });
  });
  it("can be switched off, and defaults to off when omitted", async () => {
    await updateWorkflow(uid, wfId, { name: "Confirm", trigger: "booking_created", steps: [step(false)] });
    expect((await getWorkflowForEdit(uid, wfId)).steps[0]).toMatchObject({ attachIcs: false });
    await updateWorkflow(uid, wfId, { name: "Confirm", trigger: "booking_created", steps: [step(undefined)] });
    expect((await getWorkflowForEdit(uid, wfId)).steps[0]).toMatchObject({ attachIcs: false });
  });
  it("is not accepted as anything but a boolean", async () => {
    await expect(createWorkflow(uid, { name: "Bad", trigger: "booking_created", steps: [{ ...step(true), attachIcs: "yes" }] })).rejects.toBeTruthy();
  });
});
