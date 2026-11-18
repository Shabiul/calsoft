/** Integration tests against the dev Postgres with isolated fixtures. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, pool, schema } from "../db";
import { createForm, deleteForm, getForm, listForms, listSubmissions, loadPublicForm, submitPublicForm, updateForm } from "./routing-forms";

const run = randomUUID().slice(0, 8);
const A = `t_${run}_ra`, B = `t_${run}_rb`;
const uname = `rt${run}`;
let evA = "", evB = "";

const config = (eventTypeId: string) => ({
  fields: [
    { id: "name", label: "Name", type: "short_text", required: true },
    { id: "email", label: "Email", type: "email", required: true },
    { id: "topic", label: "Topic", type: "dropdown", required: true, options: ["Sales", "Support"] },
    { id: "seats", label: "Seats", type: "short_text", required: true, visibleWhen: { match: "all", conditions: [{ field: "topic", op: "eq", value: "Sales" }] } },
  ],
  rules: [
    { match: "all", when: [{ field: "topic", op: "eq", value: "Sales" }, { field: "seats", op: "gt", value: "10" }], destination: { type: "event", eventTypeId } },
    { match: "all", when: [{ field: "topic", op: "eq", value: "Support" }], destination: { type: "url", url: "https://help.example.com/x" } },
  ],
  fallback: { type: "message", title: "Hi", message: "We will reply by email." },
});

beforeAll(async () => {
  await db.insert(schema.users).values({ id: A, name: "Host A", email: `${A}@example.test`, username: uname, timeZone: "UTC" });
  await db.insert(schema.users).values({ id: B, name: "Host B", email: `${B}@example.test`, timeZone: "UTC" });
  evA = (await db.insert(schema.eventTypes).values({ ownerUserId: A, slug: `big-${run}`, title: "Big", durationMinutes: 30 }).returning())[0]!.id;
  evB = (await db.insert(schema.eventTypes).values({ ownerUserId: B, slug: `b-${run}`, title: "B", durationMinutes: 30 }).returning())[0]!.id;
});
afterAll(async () => {
  await db.delete(schema.routingForms).where(inArray(schema.routingForms.ownerUserId, [A, B]));
  await db.delete(schema.eventTypes).where(inArray(schema.eventTypes.id, [evA, evB]));
  await db.delete(schema.users).where(eq(schema.users.id, A));
  await db.delete(schema.users).where(eq(schema.users.id, B));
  await pool.end();
});

describe("routing forms service", () => {
  it("validates and rejects routing to another user's event type", async () => {
    await expect(createForm(A, { name: "Bad", slug: "bad", config: config(evB) })).rejects.toMatchObject({ status: 422 });
    await expect(createForm(A, { name: "Bad", slug: "Bad Slug!" })).rejects.toMatchObject({ status: 422 });
    await expect(createForm(A, { name: "Bad", config: { fields: [], rules: [] } })).rejects.toMatchObject({ status: 422 });
  });

  it("CRUD, slug uniqueness, ownership", async () => {
    const f = await createForm(A, { name: "Intake", slug: "intake", config: config(evA) });
    await expect(createForm(A, { name: "Intake 2", slug: "intake" })).rejects.toMatchObject({ status: 409 });
    expect((await listForms(A)).map((x) => x.id)).toContain(f.id);
    expect(await listForms(B)).toEqual([]);
    await expect(getForm(B, f.id)).rejects.toMatchObject({ status: 404 });
    await expect(updateForm(B, f.id, { name: "x", slug: "x", config: config(evB) })).rejects.toMatchObject({ status: 404 });
    const u = await updateForm(A, f.id, { name: "Intake v2", slug: "intake", config: config(evA) });
    expect(u.name).toBe("Intake v2");
    await expect(deleteForm(B, f.id)).rejects.toMatchObject({ status: 404 });
  });

  it("public flow: validation, branching, redirect prefill, submissions stored, hidden field dropped", async () => {
    const pub = await loadPublicForm(uname, "intake");
    expect(pub?.fields).toHaveLength(4);
    expect(await loadPublicForm(uname, "missing")).toBeNull();
    expect(await loadPublicForm("nobody-" + run, "intake")).toBeNull();

    const bad = await submitPublicForm(uname, "intake", { name: "Ann", email: "bad", topic: "Sales" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) { expect(bad.errors.email).toBeDefined(); expect(bad.errors.seats).toBeDefined(); }

    const sales = await submitPublicForm(uname, "intake", { name: "Ann Lee", email: "ann@example.com", topic: "Sales", seats: "50" });
    expect(sales).toMatchObject({ ok: true, result: { kind: "redirect", external: false } });
    if (sales.ok && sales.result.kind === "redirect") {
      expect(sales.result.url).toBe(`/${uname}/big-${run}?name=Ann+Lee&email=ann%40example.com`);
    }

    const support = await submitPublicForm(uname, "intake", { name: "Bo", email: "bo@example.com", topic: "Support", seats: "99" });
    expect(support).toMatchObject({ ok: true, result: { kind: "redirect", url: "https://help.example.com/x", external: true } });

    const fb = await submitPublicForm(uname, "intake", { name: "Cy", email: "cy@example.com", topic: "Sales", seats: "2" });
    expect(fb).toMatchObject({ ok: true, result: { kind: "message", title: "Hi" } });

    const form = (await listForms(A)).find((x) => x.slug === "intake")!;
    const subs = await listSubmissions(A, form.id);
    expect(subs.total).toBe(3);
    expect(subs.rows.find((r) => r.email === "bo@example.com")!.answers).not.toHaveProperty("seats"); // hidden by branching
    expect(subs.rows.find((r) => r.email === "ann@example.com")!.outcome).toMatchObject({ type: "event", source: "rule", ruleIndex: 0 });
    await expect(listSubmissions(B, form.id)).rejects.toMatchObject({ status: 404 });
  });

  it("deleting an event type target degrades to a message, not a broken redirect", async () => {
    const f = await createForm(A, { name: "Gone", slug: "gone", config: { ...config(evA), rules: [{ match: "all", when: [{ field: "topic", op: "eq", value: "Sales" }], destination: { type: "event", eventTypeId: evA } }] } });
    await db.update(schema.eventTypes).set({ isActive: false }).where(eq(schema.eventTypes.id, evA));
    const r = await submitPublicForm(uname, "gone", { name: "A", email: "a@example.com", topic: "Sales", seats: "1" });
    expect(r).toMatchObject({ ok: true, result: { kind: "message", title: "Currently unavailable" } });
    await db.update(schema.eventTypes).set({ isActive: true }).where(eq(schema.eventTypes.id, evA));
    await deleteForm(A, f.id);
  });
});
