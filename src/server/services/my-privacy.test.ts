import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { db, pool, schema } from "../db";
import { devLogProvider, devOutbox, setEmailProviderForTests } from "../notifications/provider";
import { alertOnNewBrowser, listWhoViewedMe } from "./my-privacy";

const run = randomUUID().slice(0, 8);
const ids: string[] = [];
async function mk(n: string) {
  const id = `mp_${run}_${n}`;
  await db.insert(schema.users).values({ id, name: `Name ${n}`, email: `${id}@example.test` });
  ids.push(id);
  return id;
}
beforeAll(() => setEmailProviderForTests(devLogProvider)); // never the real mail provider
afterAll(async () => {
  setEmailProviderForTests(null);
  await db.delete(schema.auditLogs).where(inArray(schema.auditLogs.actorId, ids));
  await db.delete(schema.users).where(inArray(schema.users.id, ids));
  await pool.end();
});

describe("who viewed me", () => {
  it("lists the people who opened my page, newest first, and nobody else's views", async () => {
    const me = await mk("me"), boss = await mk("boss"), other = await mk("other");
    await db.insert(schema.auditLogs).values([
      { actorId: boss, action: "oversight.member_viewed", entity: "user", entityId: me, meta: { role: "manager" } },
      { actorId: boss, action: "oversight.member_viewed", entity: "user", entityId: other, meta: { role: "manager" } },
    ]);
    const v = await listWhoViewedMe(me);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ viewerName: "Name boss", viewerRole: "manager" });
  });
});

describe("new-browser alert", () => {
  it("is quiet on the first sign-in, quiet on a known browser, and emails on a new one", async () => {
    const id = await mk("dev");
    const sent = () => devOutbox.filter((m) => m.to === `${id}@example.test`).length;
    expect(await alertOnNewBrowser(id, "Chrome on Windows", "google")).toBe(false); // first ever sign-in
    await db.insert(schema.signInLogs).values({ userId: id, provider: "google", device: "Chrome on Windows" });
    expect(await alertOnNewBrowser(id, "Chrome on Windows", "google")).toBe(false); // known
    expect(await alertOnNewBrowser(id, "Unknown device", "google")).toBe(false);
    expect(await alertOnNewBrowser(id, "Safari on iOS", "google")).toBe(true);
    expect(sent()).toBe(1);
    expect(devOutbox.at(-1)!.subject).toContain("Safari on iOS");
  });
});
