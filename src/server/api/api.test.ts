/** Integration tests for the REST API layer against the real dev Postgres (isolated fixtures, cleaned up). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { db, pool, schema } from "../db";
import { createApiKey } from "../api-keys";
import { setBookingEventHook } from "../services/booking";
import * as events from "@/app/api/v1/events/route";
import * as eventById from "@/app/api/v1/events/[id]/route";
import * as bookings from "@/app/api/v1/bookings/route";
import * as bookingById from "@/app/api/v1/bookings/[id]/route";
import * as bookingCancel from "@/app/api/v1/bookings/[id]/cancel/route";
import * as slots from "@/app/api/v1/availability/slots/route";
import * as contacts from "@/app/api/v1/contacts/route";

const run = randomUUID().slice(0, 8);
const uid = (n: string) => `api_${run}_${n}`;
const userIds: string[] = [];
let keyA = "", keyB = "", keyReadOnly = "", keyLow = "", keyLowId = "";
let eventA = "", eventB = "", idA = "";
const BASE = "http://localhost/api/v1";

const call = <P,>(h: (req: Request, ctx?: { params?: Promise<P> | P }) => Promise<Response>, path: string, o: { key?: string | null; method?: string; body?: unknown; params?: P; headers?: Record<string, string> } = {}) =>
  h(new Request(BASE + path, {
    method: o.method ?? "GET",
    headers: { ...(o.key === null ? {} : { authorization: `Bearer ${o.key}` }), "content-type": "application/json", ...o.headers },
    body: o.body === undefined ? undefined : typeof o.body === "string" ? o.body : JSON.stringify(o.body),
  }), { params: Promise.resolve((o.params ?? {}) as P) });

async function mkUser(n: string) {
  const id = uid(n);
  await db.insert(schema.users).values({ id, name: `User ${n}`, email: `${id}@example.test`, timeZone: "UTC" });
  const [s] = await db.insert(schema.availabilitySchedules).values({ userId: id, name: "Work", timeZone: "UTC", isDefault: true }).returning();
  await db.insert(schema.availabilityRules).values([0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ scheduleId: s.id, weekday, startTime: "08:00", endTime: "20:00" })));
  userIds.push(id);
  return id;
}
async function mkEvent(owner: string, name: string) {
  const [e] = await db.insert(schema.eventTypes).values({ ownerUserId: owner, slug: `${name}-${run}`, title: name, durationMinutes: 30, minNoticeMinutes: 0, maxHorizonDays: 30 }).returning();
  return e.id;
}

beforeAll(async () => {
  setBookingEventHook(() => undefined);
  const [a, b] = await Promise.all([mkUser("a"), mkUser("b")]);
  idA = a;
  eventA = await mkEvent(a, "ea");
  eventB = await mkEvent(b, "eb");
  const all = ["bookings:read", "bookings:write", "event_types:read", "event_types:write", "availability:read", "contacts:read", "contacts:write"];
  keyA = (await createApiKey(a, { name: "a", scopes: all })).key;
  keyB = (await createApiKey(b, { name: "b", scopes: all })).key;
  keyReadOnly = (await createApiKey(a, { name: "ro", scopes: ["bookings:read", "event_types:read"] })).key;
  const low = await createApiKey(a, { name: "low", scopes: ["event_types:read"] });
  keyLow = low.key; keyLowId = low.apiKey.id;
});

afterAll(async () => {
  setBookingEventHook(null);
  const evs = await db.select({ id: schema.eventTypes.id }).from(schema.eventTypes).where(inArray(schema.eventTypes.ownerUserId, userIds));
  const ids = evs.map((e) => e.id);
  if (ids.length) {
    await db.delete(schema.bookings).where(inArray(schema.bookings.eventTypeId, ids));
    await db.delete(schema.eventTypes).where(inArray(schema.eventTypes.id, ids));
  }
  await db.delete(schema.auditLogs).where(inArray(schema.auditLogs.actorId, userIds));
  await db.delete(schema.users).where(inArray(schema.users.id, userIds));
  await pool.end();
});

const errCode = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;

describe("auth", () => {
  it("rejects missing / malformed / unknown keys with the error envelope and request id", async () => {
    for (const key of [null, "garbage", "mf_live_doesnotexist"]) {
      const r = await call(events.GET, "/events", { key });
      expect(r.status).toBe(401);
      expect(r.headers.get("x-request-id")).toBeTruthy();
      const j = (await r.json()) as { error: { code: string; message: string; request_id: string } };
      expect(j.error.code).toBe("UNAUTHORIZED");
      expect(j.error.request_id).toBe(r.headers.get("x-request-id"));
    }
  });
  it("blocks suspended owners", async () => {
    const id = uid("susp");
    await db.insert(schema.users).values({ id, name: "S", email: `${id}@example.test`, status: "suspended" });
    userIds.push(id);
    const { key } = await createApiKey(id, { name: "s", scopes: ["event_types:read"] });
    const r = await call(events.GET, "/events", { key });
    expect(r.status).toBe(403);
    expect(await errCode(r)).toBe("ACCOUNT_SUSPENDED");
  });
});

describe("scopes", () => {
  it("enforces scope per route", async () => {
    const ok = await call(events.GET, "/events", { key: keyReadOnly });
    expect(ok.status).toBe(200);
    const denied = await call(bookings.POST, "/bookings", { key: keyReadOnly, method: "POST", body: {} });
    expect(denied.status).toBe(403);
    expect(await errCode(denied)).toBe("INSUFFICIENT_SCOPE");
    const denied2 = await call(events.POST, "/events", { key: keyReadOnly, method: "POST", body: {} });
    expect(denied2.status).toBe(403);
    const denied3 = await call(contacts.GET, "/contacts", { key: keyReadOnly });
    expect(denied3.status).toBe(403);
  });
});

describe("rate limiting", () => {
  it("sets headers and returns 429 once the per-key limit is exceeded", async () => {
    const prev = process.env.API_RATE_LIMIT;
    process.env.API_RATE_LIMIT = "3";
    try {
      const rs: Response[] = [];
      for (let i = 0; i < 4; i++) rs.push(await call(events.GET, "/events", { key: keyLow }));
      expect(rs[0].headers.get("x-ratelimit-limit")).toBe("3");
      expect(rs[0].headers.get("x-ratelimit-remaining")).toBe("2");
      expect(rs[0].headers.get("x-ratelimit-reset")).toBeTruthy();
      expect(rs.slice(0, 3).map((r) => r.status)).toEqual([200, 200, 200]);
      expect(rs[3].status).toBe(429);
      expect(rs[3].headers.get("retry-after")).toBeTruthy();
      expect(await errCode(rs[3])).toBe("RATE_LIMITED");
      expect(keyLowId).toBeTruthy();
    } finally {
      if (prev === undefined) delete process.env.API_RATE_LIMIT; else process.env.API_RATE_LIMIT = prev;
    }
  });
});

describe("pagination + filtering", () => {
  it("paginates events with cursors without duplicates", async () => {
    const a = idA;
    for (let i = 0; i < 4; i++) await db.insert(schema.eventTypes).values({ ownerUserId: a, slug: `p${i}-${run}`, title: `P${i}`, createdAt: new Date(Date.now() - i * 1000) });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const r: Response = await call(events.GET, `/events?limit=2${cursor ? `&cursor=${cursor}` : ""}`, { key: keyA });
      const j = (await r.json()) as { data: { id: string }[]; has_more: boolean; next_cursor: string | null };
      expect(j.data.length).toBeLessThanOrEqual(2);
      seen.push(...j.data.map((d) => d.id));
      if (!j.has_more) { expect(j.next_cursor).toBeNull(); break; }
      cursor = j.next_cursor;
      expect(cursor).toBeTruthy();
    }
    expect(seen.length).toBe(5);
    expect(new Set(seen).size).toBe(5);
  });
  it("rejects bad pagination params and cursors with 422", async () => {
    const r1 = await call(events.GET, "/events?limit=1000", { key: keyA });
    expect(r1.status).toBe(422);
    const r2 = await call(events.GET, "/events?cursor=%%%", { key: keyA });
    expect(r2.status).toBe(422);
  });
});

describe("validation", () => {
  it("returns details for invalid bodies and invalid JSON", async () => {
    const r = await call(bookings.POST, "/bookings", { key: keyA, method: "POST", body: { event_id: "nope", invitee: {} } });
    expect(r.status).toBe(422);
    const j = (await r.json()) as { error: { code: string; details: { path: string }[] } };
    expect(j.error.code).toBe("VALIDATION");
    expect(j.error.details.some((d) => d.path === "event_id")).toBe(true);
    const bad = await call(bookings.POST, "/bookings", { key: keyA, method: "POST", body: "{not json" });
    expect(bad.status).toBe(422);
    const q = await call(slots.GET, `/availability/slots?event_id=${eventA}&from=x&to=y`, { key: keyA });
    expect(q.status).toBe(422);
  });
});

describe("tenant isolation", () => {
  it("never exposes another tenant's event types, slots or bookings", async () => {
    const get = await call(eventById.GET, `/events/${eventB}`, { key: keyA, params: { id: eventB } });
    expect(get.status).toBe(404);
    const patch = await call(eventById.PATCH, `/events/${eventB}`, { key: keyA, method: "PATCH", body: { title: "x" }, params: { id: eventB } });
    expect(patch.status).toBe(404);
    const del = await call(eventById.DELETE, `/events/${eventB}`, { key: keyA, method: "DELETE", params: { id: eventB } });
    expect(del.status).toBe(404);
    const sl = await call(slots.GET, `/availability/slots?event_id=${eventB}&from=${new Date().toISOString()}&to=${new Date(Date.now() + 86400000).toISOString()}`, { key: keyA });
    expect(sl.status).toBe(404);
    const book = await call(bookings.POST, "/bookings", {
      key: keyA, method: "POST",
      body: { event_id: eventB, starts_at: new Date(Date.now() + 3600_000).toISOString(), invitee: { name: "X", email: "x@example.test", time_zone: "UTC" } },
    });
    expect(book.status).toBe(404);
    const list = (await (await call(events.GET, "/events?limit=100", { key: keyA })).json()) as { data: { id: string }[] };
    expect(list.data.some((e) => e.id === eventB)).toBe(false);
  });

  it("scopes bookings and contacts to the key owner", async () => {
    const s = await (await call(slots.GET, `/availability/slots?event_id=${eventB}&from=${new Date().toISOString()}&to=${new Date(Date.now() + 2 * 86400000).toISOString()}`, { key: keyB })).json() as { data: { starts_at: string }[] };
    const created = await call(bookings.POST, "/bookings", {
      key: keyB, method: "POST",
      body: { event_id: eventB, starts_at: s.data[0].starts_at, invitee: { name: "I", email: `i-${run}@example.test`, time_zone: "UTC" } },
    });
    expect(created.status).toBe(201);
    const b = (await created.json()) as { id: string; manage_token: string };
    expect(b.manage_token).toBeTruthy();
    expect((await call(bookingById.GET, `/bookings/${b.id}`, { key: keyB, params: { id: b.id } })).status).toBe(200);
    expect((await call(bookingById.GET, `/bookings/${b.id}`, { key: keyA, params: { id: b.id } })).status).toBe(404);
    expect((await call(bookingCancel.POST, `/bookings/${b.id}/cancel`, { key: keyA, method: "POST", params: { id: b.id } })).status).toBe(404);
    const la = (await (await call(bookings.GET, "/bookings", { key: keyA })).json()) as { data: unknown[] };
    expect(la.data).toHaveLength(0);
    const lb = (await (await call(bookings.GET, `/bookings?status=confirmed&invitee_email=i-${run}@example.test`, { key: keyB })).json()) as { data: { id: string }[] };
    expect(lb.data.map((x) => x.id)).toEqual([b.id]);
    // cancel by owner works
    const c = await call(bookingCancel.POST, `/bookings/${b.id}/cancel`, { key: keyB, method: "POST", params: { id: b.id }, body: { reason: "test" } });
    expect(c.status).toBe(200);
    expect(((await c.json()) as { status: string }).status).toBe("cancelled");

    const ct = await call(contacts.POST, "/contacts", { key: keyA, method: "POST", body: { email: `c-${run}@example.test`, name: "C" } });
    expect(ct.status).toBe(201);
    const dup = await call(contacts.POST, "/contacts", { key: keyA, method: "POST", body: { email: `c-${run}@example.test` } });
    expect(dup.status).toBe(409);
    const lbC = (await (await call(contacts.GET, "/contacts", { key: keyB })).json()) as { data: { email: string }[] };
    expect(lbC.data.some((x) => x.email === `c-${run}@example.test`)).toBe(false);
  });
});

describe("booking via API prevents double booking", () => {
  it("allows exactly one of many concurrent creates for the same slot and replays idempotently", async () => {
    const s = (await (await call(slots.GET, `/availability/slots?event_id=${eventA}&from=${new Date().toISOString()}&to=${new Date(Date.now() + 2 * 86400000).toISOString()}`, { key: keyA })).json()) as { data: { starts_at: string }[] };
    const start = s.data[1].starts_at;
    const mk = (n: number, idem?: string) => call(bookings.POST, "/bookings", {
      key: keyA, method: "POST", headers: idem ? { "idempotency-key": idem } : {},
      body: { event_id: eventA, starts_at: start, invitee: { name: `N${n}`, email: `n${n}-${run}@example.test`, time_zone: "UTC" } },
    });
    const rs = await Promise.all([mk(1), mk(2), mk(3), mk(4)]);
    const codes = rs.map((r) => r.status).sort();
    expect(codes).toEqual([201, 409, 409, 409]);
    const lost = rs.find((r) => r.status === 409)!;
    expect(await errCode(lost)).toBe("SLOT_UNAVAILABLE");
    const active = await db.select().from(schema.bookings).where(eq(schema.bookings.eventTypeId, eventA));
    expect(active.filter((b) => b.status === "confirmed" && b.startsAt.toISOString() === start)).toHaveLength(1);

    // idempotent replay on a different slot
    const start2 = s.data[3].starts_at;
    const body = { event_id: eventA, starts_at: start2, invitee: { name: "Z", email: `z-${run}@example.test`, time_zone: "UTC" } };
    const r1 = await call(bookings.POST, "/bookings", { key: keyA, method: "POST", body, headers: { "idempotency-key": `k-${run}` } });
    const r2 = await call(bookings.POST, "/bookings", { key: keyA, method: "POST", body, headers: { "idempotency-key": `k-${run}` } });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect(((await r2.json()) as { id: string }).id).toBe(((await r1.json()) as { id: string }).id);
  });
});

describe("audit logging", () => {
  it("writes an audit_log row for mutations", async () => {
    const r = await call(contacts.POST, "/contacts", { key: keyA, method: "POST", body: { email: `aud-${run}@example.test` } });
    expect(r.status).toBe(201);
    const rows = await db.select().from(schema.auditLogs).where(eq(schema.auditLogs.actorId, idA));
    expect(rows.some((x) => x.action === "contact.created" && (x.meta as { requestId?: string })?.requestId === r.headers.get("x-request-id"))).toBe(true);
  });
});
