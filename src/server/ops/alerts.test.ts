import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, pool, schema } from "../db";
import { devLogProvider, devOutbox, setEmailProviderForTests } from "../notifications/provider";
import { alertRecipients, evaluateHealth, runOpsCheck, sendOpsAlert } from "./alerts";

const run = randomUUID().slice(0, 8);
const marker = `ops-${run}@example.test`;
const ids: string[] = [];
beforeAll(() => setEmailProviderForTests(devLogProvider)); // never the real mail provider
afterAll(async () => {
  setEmailProviderForTests(null);
  if (ids.length) await db.delete(schema.notificationLogs).where(inArray(schema.notificationLogs.id, ids));
  await db.delete(schema.notificationLogs).where(eq(schema.notificationLogs.recipient, marker));
  await pool.end();
});

describe("health evaluation", () => {
  it("flags permanently failing emails once there are three in 30 minutes, and old ones do not count", async () => {
    const before = (await evaluateHealth()).find((f) => f.code === "emails_dead")?.count ?? 0;
    const rows = await db.insert(schema.notificationLogs).values([1, 2, 3].map((n) => ({ kind: "reminder", recipient: marker, status: "dead" as const, dedupeKey: `ops:${run}:${n}` }))).returning({ id: schema.notificationLogs.id });
    ids.push(...rows.map((r) => r.id));
    const f = (await evaluateHealth()).find((x) => x.code === "emails_dead");
    expect(f?.count).toBe(before + 3);
    // an hour from now these are older than the 30-minute window
    expect((await evaluateHealth(new Date(Date.now() + 60 * 60_000))).find((x) => x.code === "emails_dead")?.count ?? 0).toBeLessThanOrEqual(before);
  });
  it("flags emails stuck in the queue for over 15 minutes", async () => {
    const [r] = await db.insert(schema.notificationLogs).values({ kind: "reminder", recipient: marker, status: "queued", dedupeKey: `ops:${run}:stuck` }).returning({ id: schema.notificationLogs.id });
    ids.push(r!.id);
    const later = new Date(Date.now() + 20 * 60_000);
    expect((await evaluateHealth(later)).some((f) => f.code === "emails_stuck")).toBe(true);
  });
});

describe("alert delivery", () => {
  it("sends to ALERT_EMAILS, falling back to the superadmin list", () => {
    const keep = { a: process.env.ALERT_EMAILS, s: process.env.SUPERADMIN_EMAILS };
    try {
      process.env.ALERT_EMAILS = " Ops@Example.com ,, b@example.com"; process.env.SUPERADMIN_EMAILS = "boss@example.com";
      expect(alertRecipients()).toEqual(["ops@example.com", "b@example.com"]);
      delete process.env.ALERT_EMAILS;
      expect(alertRecipients()).toEqual(["boss@example.com"]);
    } finally { for (const [k, v] of [["ALERT_EMAILS", keep.a], ["SUPERADMIN_EMAILS", keep.s]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  });
  it("emails each recipient, escapes the text, and does nothing without recipients or findings", async () => {
    const keep = { a: process.env.ALERT_EMAILS, s: process.env.SUPERADMIN_EMAILS };
    try {
      process.env.ALERT_EMAILS = `a-${run}@example.test`;
      expect(await sendOpsAlert([])).toBe(0);
      expect(await sendOpsAlert([{ code: "x", count: 2, message: "Emails <fail>." }])).toBe(1);
      const m = devOutbox.filter((x) => x.to === `a-${run}@example.test`).at(-1)!;
      expect(m.subject).toContain("Emails <fail>");
      expect(m.html).toContain("Emails &lt;fail&gt;.");
      delete process.env.ALERT_EMAILS; delete process.env.SUPERADMIN_EMAILS;
      expect(await sendOpsAlert([{ code: "x", count: 1, message: "m" }])).toBe(0);
    } finally { for (const [k, v] of [["ALERT_EMAILS", keep.a], ["SUPERADMIN_EMAILS", keep.s]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  });
  it("alerts at most once per claim window", async () => {
    const keep = process.env.ALERT_EMAILS;
    process.env.ALERT_EMAILS = `b-${run}@example.test`;
    try {
      const [r] = await db.insert(schema.notificationLogs).values({ kind: "reminder", recipient: marker, status: "queued", dedupeKey: `ops:${run}:stuck2` }).returning({ id: schema.notificationLogs.id });
      ids.push(r!.id);
      const later = new Date(Date.now() + 20 * 60_000);
      let claimed = false;
      const claim = async () => { if (claimed) return false; claimed = true; return true; };
      expect(await runOpsCheck(claim, later)).toBe(true);
      expect(await runOpsCheck(claim, later)).toBe(false);
    } finally { if (keep === undefined) delete process.env.ALERT_EMAILS; else process.env.ALERT_EMAILS = keep; }
  });
});
