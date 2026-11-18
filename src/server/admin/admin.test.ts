import { afterAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, pool, schema } from "../db";
import { audit } from "../audit";
import { getBookingStats, getHealth, listAudit, listUsers, parseLimitsJson, setUserStatus, savePlan } from "./index";

// connection() only works inside a request scope; the services call it to opt out of prerendering.
vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));

const run = randomUUID().slice(0, 8);
const ids = { admin: `adm_${run}_a`, user: `adm_${run}_u`, other: `adm_${run}_o` };

afterAll(async () => {
  await db.delete(schema.sessions).where(inArray(schema.sessions.userId, Object.values(ids)));
  await db.delete(schema.auditLogs).where(inArray(schema.auditLogs.actorId, Object.values(ids)));
  await db.delete(schema.subscriptionPlans).where(eq(schema.subscriptionPlans.id, `t-${run}`));
  await db.delete(schema.users).where(inArray(schema.users.id, Object.values(ids)));
  await pool.end();
});

describe("admin services", () => {
  it("suspends and reactivates a user, revokes sessions, audits, and protects superadmins/self", async () => {
    await db.insert(schema.users).values([
      { id: ids.admin, name: "Adm", email: `${ids.admin}@example.test`, platformRole: "superadmin" },
      { id: ids.user, name: "Usr", email: `${ids.user}@example.test` },
    ]);
    await db.insert(schema.sessions).values({ id: `s_${run}`, token: `tok_${run}`, userId: ids.user, expiresAt: new Date(Date.now() + 1e6) });
    await setUserStatus(ids.admin, ids.user, "suspended");
    const [u] = await db.select().from(schema.users).where(eq(schema.users.id, ids.user));
    expect(u.status).toBe("suspended");
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.userId, ids.user))).toHaveLength(0);
    expect((await listUsers({ q: ids.user, status: "suspended" })).rows).toHaveLength(1);
    await setUserStatus(ids.admin, ids.user, "active");
    expect((await listUsers({ q: ids.user, status: "suspended" })).rows).toHaveLength(0);
    await expect(setUserStatus(ids.admin, ids.admin, "suspended")).rejects.toMatchObject({ status: 403 });
    await expect(setUserStatus(ids.user, ids.admin, "suspended")).rejects.toMatchObject({ status: 403 });
    const a = await listAudit({ actor: ids.admin, action: "admin.user" });
    expect(a.rows.map((r) => r.action).sort()).toEqual(["admin.user.reactivated", "admin.user.suspended"]);
  });

  it("filters the audit log and validates plan limits JSON", async () => {
    await audit({ id: ids.other, ip: "1.2.3.4" }, "x.test", { type: "thing", id: "1" }, { a: 1 });
    expect((await listAudit({ actor: ids.other, entity: "thing" })).rows).toHaveLength(1);
    expect((await listAudit({ actor: ids.other, entity: "nope" })).rows).toHaveLength(0);
    expect(() => parseLimitsJson("{bad")).toThrow();
    expect(() => parseLimitsJson('{"a":"str"}')).toThrow();
    expect(parseLimitsJson('{"maxEventTypes":3,"flag":true}')).toEqual({ maxEventTypes: 3, flag: true });
    await savePlan(ids.admin, { id: `t-${run}`, name: "T", priceMonthly: 0, currency: "usd", isActive: true, limits: { maxEventTypes: 2 } });
    const [p] = await db.select().from(schema.subscriptionPlans).where(eq(schema.subscriptionPlans.id, `t-${run}`));
    expect(p.limits).toEqual({ maxEventTypes: 2 });
    expect(p.currency).toBe("USD");
  });

  it("reports stats and health without throwing", async () => {
    const s = await getBookingStats(7);
    expect(typeof s.total).toBe("number");
    const h = await getHealth();
    expect(h.database.ok).toBe(true);
  });
});
