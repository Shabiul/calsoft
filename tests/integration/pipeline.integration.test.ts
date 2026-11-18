/**
 * Real Postgres + Redis. Runs the actual workers in-process under an isolated queue prefix.
 * All rows use unique ids/emails and are deleted at the end.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, and } from "drizzle-orm";
import type { Worker } from "bullmq";

process.env.QUEUE_PREFIX = `test-${randomUUID().slice(0, 8)}`;

const run = randomUUID().slice(0, 8);
const hostId = `u_host_${run}`;
let eventTypeId = "";
const bookingIds: string[] = [];
const workers: Worker[] = [];
let server: http.Server;
const received: { headers: http.IncomingHttpHeaders; body: string }[] = [];

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let m: Awaited<ReturnType<typeof load>>;
async function load() {
  const [dbm, schema, queue, rt, proc, rem, svc, prov, wh, wf, sign, ep] = await Promise.all([
    import("@/server/db"), import("@/server/db/schema"), import("@/server/queue"), import("@/worker/runtime"),
    import("@/worker/processors"), import("@/server/notifications/reminders"), import("@/server/notifications/service"),
    import("@/server/notifications/provider"), import("@/server/webhooks/endpoints"), import("@/server/workflows/service"),
    import("@/server/webhooks/signing"), import("@/server/webhooks/dispatch"),
  ]);
  return { ...dbm, ...schema, ...queue, ...rt, ...proc, ...rem, ...svc, ...prov, ...wh, ...wf, ...sign, ...ep };
}

const until = async (fn: () => boolean | Promise<boolean>, ms = 20_000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 150)); }
  throw new Error("timeout waiting for condition");
};

let slot = 0;
async function makeBooking(opts: { startsInMs: number; status?: "confirmed" | "pending_payment"; holdExpiresAt?: Date; invitee?: string }) {
  const startsAt = new Date(Date.now() + opts.startsInMs + (slot++) * 45 * 60_000);
  const endsAt = new Date(startsAt.getTime() + 30 * 60_000);
  const [b] = await m.db.insert(m.bookings).values({
    eventTypeId, hostUserId: hostId, startsAt, endsAt, blockStart: startsAt, blockEnd: endsAt,
    status: opts.status ?? "confirmed", inviteeTimeZone: "America/New_York", hostTimeZone: "UTC", holdExpiresAt: opts.holdExpiresAt,
  }).returning();
  await m.db.insert(m.invitees).values({ bookingId: b.id, name: "Ivy <b>Invitee</b>", email: opts.invitee ?? `ivy_${run}_${bookingIds.length}@example.test` });
  bookingIds.push(b.id);
  return b;
}

beforeAll(async () => {
  m = await load();
  await m.db.insert(m.users).values({ id: hostId, name: "Host Person", email: `host_${run}@example.test`, username: `host_${run}` });
  const [et] = await m.db.insert(m.eventTypes).values({
    ownerUserId: hostId, slug: `intro-${run}`, title: "Intro Call", reminders: [1440, 60],
  }).returning();
  eventTypeId = et.id;
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { received.push({ headers: req.headers, body: Buffer.concat(chunks).toString() }); res.statusCode = 200; res.end("ok"); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});
function startWorkers() {
  workers.push(
    m.createWorker(m.QUEUES.events, m.processEvents), m.createWorker(m.QUEUES.notifications, m.processNotifications),
    m.createWorker(m.QUEUES.webhooks, m.processWebhooks), m.createWorker(m.QUEUES.workflows, m.processWorkflows),
  );
}

afterAll(async () => {
  for (const w of workers) await m.closeWorker(w, true).catch(() => undefined);
  server?.close();
  if (bookingIds.length) {
    await m.db.delete(m.notificationLogs).where(inArray(m.notificationLogs.bookingId, bookingIds));
    await m.db.delete(m.bookings).where(inArray(m.bookings.id, bookingIds));
  }
  await m.db.delete(m.notificationLogs).where(eq(m.notificationLogs.recipient, `dead_${run}@example.test`));
  await m.db.delete(m.eventTypes).where(eq(m.eventTypes.id, eventTypeId));
  await m.db.delete(m.users).where(eq(m.users.id, hostId)); // cascades webhook endpoints, workflows, api keys
  for (const n of Object.values(m.QUEUES)) await m.getQueue(n).obliterate({ force: true }).catch(() => undefined);
  await m.closeQueues();
  await m.pool.end();
});

describe("notification idempotency + retry + dead letter", () => {
  it("dedupe_key makes queueNotification idempotent; failures retry then go dead; success sends ICS", async () => {
    const b = await makeBooking({ startsInMs: 5 * 24 * 3600_000 });
    const failing = { name: "failing", send: async () => { throw new Error("smtp down"); } };
    m.setEmailProviderForTests(failing);
    const recipient = `dead_${run}@example.test`;
    const key = `confirmation:${b.id}:dead`;
    const a = await m.queueNotification({ kind: "confirmation", bookingId: b.id, recipient, dedupeKey: key });
    const again = await m.queueNotification({ kind: "confirmation", bookingId: b.id, recipient, dedupeKey: key });
    expect(a.deduped).toBe(false);
    expect(again).toEqual({ id: a.id, deduped: true });
    const rows = await m.db.select().from(m.notificationLogs).where(eq(m.notificationLogs.dedupeKey, key));
    expect(rows).toHaveLength(1);

    // drive attempts directly (no waiting on backoff)
    await expect(m.processNotification({ logId: a.id }, { attemptsMade: 0, isFinal: false })).rejects.toThrow("smtp down");
    let [row] = await m.db.select().from(m.notificationLogs).where(eq(m.notificationLogs.id, a.id));
    expect(row.status).toBe("failed"); expect(row.attempts).toBe(1); expect(row.error).toContain("smtp down");
    await expect(m.processNotification({ logId: a.id }, { attemptsMade: 5, isFinal: true })).rejects.toThrow();
    [row] = await m.db.select().from(m.notificationLogs).where(eq(m.notificationLogs.id, a.id));
    expect(row.status).toBe("dead"); expect(row.attempts).toBe(6);
    expect(await m.processNotification({ logId: a.id }, { attemptsMade: 6, isFinal: true })).toBe("already_done");

    // recovery path on a fresh log
    m.setEmailProviderForTests(null);
    const sent: { to: string; attachments?: unknown[] }[] = [];
    m.setEmailProviderForTests({ name: "cap", send: async (msg) => { sent.push(msg); return {}; } });
    const ok = await m.queueNotification({ kind: "confirmation", bookingId: b.id, recipient: `ok_${run}@example.test`, dedupeKey: `confirmation:${b.id}:ok` });
    await m.processNotification({ logId: ok.id }, { attemptsMade: 0, isFinal: false });
    expect(sent).toHaveLength(1); expect(sent[0].attachments).toHaveLength(1);
    const [okRow] = await m.db.select().from(m.notificationLogs).where(eq(m.notificationLogs.id, ok.id));
    expect(okRow.status).toBe("sent"); expect(okRow.sentAt).not.toBeNull();
    m.setEmailProviderForTests(null);
  });
});

describe("reminders", () => {
  it("creates rows from event_type.reminders, skipping ones already in the past", async () => {
    const far = await makeBooking({ startsInMs: 5 * 24 * 3600_000 });
    expect(await m.createRemindersForBooking(far.id)).toBe(2);
    expect(await m.createRemindersForBooking(far.id)).toBe(0); // idempotent
    const soon = await makeBooking({ startsInMs: 3 * 3600_000 });
    expect(await m.createRemindersForBooking(soon.id)).toBe(1); // only the 60-min one
    const pending = await makeBooking({ startsInMs: 5 * 24 * 3600_000, status: "pending_payment" });
    expect(await m.createRemindersForBooking(pending.id)).toBe(0);
  });

  it("due selection is exact, claims rows with SKIP LOCKED, and processing is exactly-once", async () => {
    const sent: string[] = [];
    m.setEmailProviderForTests({ name: "cap", send: async (msg) => { sent.push(`${msg.to}|${msg.subject}`); return {}; } });
    const b = await makeBooking({ startsInMs: 5 * 24 * 3600_000 });
    await m.createRemindersForBooking(b.id);
    const now = new Date();
    // before any is due
    await m.db.transaction(async (tx) => { expect((await m.selectDueReminders(tx, now)).filter((r) => r.bookingId === b.id)).toHaveLength(0); });
    // make the 1440-min reminder due
    await m.db.update(m.reminders).set({ sendAt: new Date(now.getTime() - 1000) }).where(and(eq(m.reminders.bookingId, b.id), eq(m.reminders.minutesBefore, 1440)));

    // SKIP LOCKED: while tx1 holds the row, tx2 sees nothing
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let tx1Saw = 0;
    const tx1 = m.db.transaction(async (tx) => {
      tx1Saw = (await m.selectDueReminders(tx, now)).filter((r) => r.bookingId === b.id).length;
      await held;
    });
    await until(() => tx1Saw === 1);
    await m.db.transaction(async (tx) => { expect((await m.selectDueReminders(tx, now)).filter((r) => r.bookingId === b.id)).toHaveLength(0); });
    release(); await tx1;

    // two concurrent processors: reminder is handled once
    await Promise.all([m.processDueReminders(now), m.processDueReminders(now)]);
    const logs = await m.db.select().from(m.notificationLogs).where(and(eq(m.notificationLogs.bookingId, b.id), eq(m.notificationLogs.kind, "reminder")));
    expect(logs).toHaveLength(2); // invitee + host
    expect(logs.every((l) => l.dedupeKey?.startsWith(`reminder:${b.id}:1440:`))).toBe(true);
    const rem = await m.db.select().from(m.reminders).where(eq(m.reminders.bookingId, b.id));
    expect(rem.filter((r) => r.sentAt)).toHaveLength(1);
    await m.processDueReminders(now); // replay: nothing new for this booking
    const logs2 = await m.db.select().from(m.notificationLogs).where(and(eq(m.notificationLogs.bookingId, b.id), eq(m.notificationLogs.kind, "reminder")));
    expect(logs2).toHaveLength(2);
    m.setEmailProviderForTests(null);
  });

  it("cancel removes unsent reminders; recompute re-plans from the new start", async () => {
    const b = await makeBooking({ startsInMs: 5 * 24 * 3600_000 });
    await m.createRemindersForBooking(b.id);
    expect(await m.cancelReminders(b.id)).toBe(2);
    expect(await m.createRemindersForBooking(b.id)).toBe(2);
    const newStart = new Date(Date.now() + 10 * 24 * 3600_000);
    await m.db.update(m.bookings).set({ startsAt: newStart, endsAt: new Date(newStart.getTime() + 1800_000), blockStart: newStart, blockEnd: new Date(newStart.getTime() + 1800_000) }).where(eq(m.bookings.id, b.id));
    expect(await m.recomputeReminders(b.id)).toBe(2);
    const rows = await m.db.select().from(m.reminders).where(eq(m.reminders.bookingId, b.id));
    const r60 = rows.find((r) => r.minutesBefore === 60)!;
    expect(r60.sendAt.getTime()).toBe(newStart.getTime() - 3600_000);
  });
});

describe("hold expiration", () => {
  it("expires only pending_payment holds that are past due", async () => {
    const past = await makeBooking({ startsInMs: 6 * 24 * 3600_000, status: "pending_payment", holdExpiresAt: new Date(Date.now() - 60_000) });
    const future = await makeBooking({ startsInMs: 6 * 24 * 3600_000, status: "pending_payment", holdExpiresAt: new Date(Date.now() + 3600_000) });
    const conf = await makeBooking({ startsInMs: 6 * 24 * 3600_000, status: "confirmed", holdExpiresAt: new Date(Date.now() - 60_000) });
    const ids = await m.expirePendingHolds();
    expect(ids).toContain(past.id); expect(ids).not.toContain(future.id); expect(ids).not.toContain(conf.id);
    const [p] = await m.db.select().from(m.bookings).where(eq(m.bookings.id, past.id));
    expect(p.status).toBe("expired");
  });
});

describe("end to end: emitEvent fans out to notifications, reminders, webhooks and workflows", () => {
  it("booking.created", async () => {
    const sent: { to: string; subject: string; attachments?: { filename: string }[] }[] = [];
    m.setEmailProviderForTests({ name: "cap", send: async (msg) => { sent.push(msg); return {}; } });
    startWorkers();
    const port = (server.address() as AddressInfo).port;
    const created = await m.createWebhookEndpoint(hostId, { url: `http://127.0.0.1:${port}/hook`, events: ["booking.created"] });
    const other = await m.createWebhookEndpoint(hostId, { url: `http://127.0.0.1:${port}/other`, events: ["booking.cancelled"] });
    const wf = await m.createWorkflow(hostId, {
      name: "Thanks", trigger: "booking_created",
      steps: [
        { action: "send_email", offsetMinutes: 0, to: "invitee", subject: "Hello {{invitee_name}}", body: "See you at {{start_time}}" },
        { action: "send_webhook", offsetMinutes: 0, url: `http://127.0.0.1:${port}/wf`, secret: "wfsecret" },
      ],
    });
    const inviteeEmail = `e2e_${run}@example.test`;
    const b = await makeBooking({ startsInMs: 5 * 24 * 3600_000, invitee: inviteeEmail });
    await m.emitEvent("booking.created", { bookingId: b.id, manageToken: "mgmt-token-xyz" });

    await until(() => sent.length >= 3 && received.length >= 2);
    const subjects = sent.map((s) => `${s.to}|${s.subject}`);
    expect(subjects.some((s) => s.startsWith(inviteeEmail) && s.includes("Confirmed"))).toBe(true);
    expect(subjects.some((s) => s.startsWith(`host_${run}@example.test`) && s.includes("New booking"))).toBe(true);
    expect(subjects.some((s) => s.startsWith(inviteeEmail) && s.includes("Hello"))).toBe(true);
    expect(sent.find((s) => s.subject.startsWith("Confirmed"))?.attachments?.[0].filename).toBe("invite.ics");
    expect((await m.db.select().from(m.reminders).where(eq(m.reminders.bookingId, b.id))).length).toBe(2);

    const hook = received.find((r) => r.body.includes('"booking.created"') && !r.body.includes('"workflow"'))!;
    expect(hook).toBeDefined();
    const secret = (await m.db.select().from(m.webhookEndpoints).where(eq(m.webhookEndpoints.id, created.endpoint.id)))[0].secret;
    expect(secret).not.toContain("whsec_"); // stored encrypted
    const { decrypt } = await import("@/lib/crypto");
    expect(m.verifySignature(decrypt(secret), hook.body, String(hook.headers["meetflow-signature"]))).toBe(true);
    expect(hook.body).not.toContain("mgmt-token-xyz");
    expect(received.some((r) => r.body.includes('"workflow"'))).toBe(true);
    // unsubscribed endpoint received nothing
    const otherDeliveries = await m.db.select().from(m.webhookDeliveries).where(eq(m.webhookDeliveries.endpointId, other.endpoint.id));
    expect(otherDeliveries).toHaveLength(0);

    await until(async () => (await m.db.select().from(m.webhookDeliveries).where(eq(m.webhookDeliveries.endpointId, created.endpoint.id)))[0]?.status === "sent");
    await until(async () => (await m.db.select().from(m.workflowExecutions).where(eq(m.workflowExecutions.workflowId, wf.id))).every((e) => e.status === "sent"));

    // replaying the same event does not duplicate side effects
    const before = sent.length;
    const ev = { eventId: randomUUID(), type: "booking.created" as const, payload: { bookingId: b.id }, at: new Date().toISOString() };
    const { handleNotificationEvent } = await import("@/server/notifications/events");
    await handleNotificationEvent(ev);
    await new Promise((r) => setTimeout(r, 1500));
    expect(sent.length).toBe(before);
    m.setEmailProviderForTests(null);
  });
});
