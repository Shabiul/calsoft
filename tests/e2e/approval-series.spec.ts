import { test, expect } from "@playwright/test";
import { cleanupUsers, fillForm, manageToken, pickSlot, q, setupHost, submitBooking, uid, E2E_EMAIL_DOMAIN } from "./helpers";

test.describe.configure({ mode: "serial" });
test.afterAll(async () => { await cleanupUsers(); });

test("requires confirmation: request -> awaiting approval -> host approves / declines from the drawer", async ({ browser }) => {
  const host = await setupHost(browser);
  await q("update event_type set requires_confirmation = true where id = $1", [host.eventTypeId]);

  // ---- guest 1 requests a booking
  const g1 = await (await browser.newContext({ timezoneId: "Europe/Berlin" })).newPage();
  const email1 = `${uid("g")}@${E2E_EMAIL_DOMAIN}`;
  await pickSlot(g1, host, 0);
  await fillForm(g1, "Pat Pending", email1);
  await submitBooking(g1);
  await expect(g1.getByRole("heading", { name: "Request sent, awaiting approval" })).toBeVisible({ timeout: 30_000 });
  const token1 = await manageToken(g1);
  const [b1] = await q("select b.* from booking b join invitee i on i.booking_id=b.id where i.email=$1", [email1]);
  expect(b1.status).toBe("pending_confirmation");

  // request emails go out (worker), but no reminders / confirmation yet
  await expect.poll(async () => (await q<{ kind: string }>("select kind from notification_log where booking_id=$1", [b1.id])).map((r) => r.kind).sort(), { timeout: 45_000 })
    .toEqual(["approval_request", "request_received"]);
  expect(await q("select 1 from reminder where booking_id=$1", [b1.id])).toHaveLength(0);

  // the slot is held while pending: it is no longer offered to another guest
  const day = b1.starts_at.toISOString().slice(0, 10);
  const slotsRes = await g1.request.get(`/api/public/slots?eventTypeId=${host.eventTypeId}&from=${day}T00:00:00Z&to=${day}T23:59:59Z&tz=UTC`);
  const offered: string[] = ((await slotsRes.json()).slots ?? []).map((s: { startsAt: string }) => new Date(s.startsAt).toISOString());
  expect(offered).not.toContain(b1.starts_at.toISOString());

  // manage page wording
  await g1.goto(`/booking/${token1}`);
  await expect(g1.getByText("Request sent, awaiting approval.")).toBeVisible();
  await expect(g1.getByText("Awaiting approval", { exact: true })).toBeVisible();

  // ---- host approves in the Scheduled events drawer
  await host.page.goto("/dashboard/scheduled");
  await expect(host.page.getByText("Needs approval").first()).toBeVisible();
  await host.page.getByRole("link").filter({ hasText: "Pat Pending" }).first().click();
  await host.page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect.poll(async () => (await q("select status from booking where id=$1", [b1.id]))[0]!.status, { timeout: 30_000 }).toBe("confirmed");
  await expect.poll(async () => (await q<{ kind: string }>("select kind from notification_log where booking_id=$1", [b1.id])).map((r) => r.kind), { timeout: 45_000 }).toContain("approved");
  await expect.poll(async () => (await q("select 1 from reminder where booking_id=$1", [b1.id])).length, { timeout: 30_000 }).toBeGreaterThan(0);
  await g1.reload();
  await expect(g1.getByText("Confirmed", { exact: true })).toBeVisible();

  // ---- guest 2 requests another slot; host declines with a reason
  const g2 = await (await browser.newContext({ timezoneId: "Europe/Berlin" })).newPage();
  const email2 = `${uid("g")}@${E2E_EMAIL_DOMAIN}`;
  await pickSlot(g2, host, 3);
  await fillForm(g2, "Dana Declined", email2);
  await submitBooking(g2);
  await expect(g2.getByRole("heading", { name: "Request sent, awaiting approval" })).toBeVisible({ timeout: 30_000 });
  const [b2] = await q("select b.* from booking b join invitee i on i.booking_id=b.id where i.email=$1", [email2]);
  expect(b2.status).toBe("pending_confirmation");
  await host.page.goto("/dashboard/scheduled");
  await host.page.getByRole("link").filter({ hasText: "Dana Declined" }).first().click();
  await host.page.getByRole("button", { name: "Decline", exact: true }).click();
  await host.page.getByPlaceholder(/Reason \(optional/).fill("Fully booked that day");
  await host.page.getByRole("button", { name: "Decline request" }).click();
  await expect.poll(async () => (await q("select status from booking where id=$1", [b2.id]))[0]!.status, { timeout: 30_000 }).toBe("cancelled");
  const [d] = await q("select cancelled_by, cancel_reason from booking where id=$1", [b2.id]);
  expect(d.cancelled_by).toBe("host");
  expect(d.cancel_reason).toBe("Fully booked that day");
  await expect.poll(async () => (await q<{ kind: string }>("select kind from notification_log where booking_id=$1", [b2.id])).map((r) => r.kind), { timeout: 45_000 }).toContain("declined");
  // slot released: bookable again
  const day2 = b2.starts_at.toISOString().slice(0, 10);
  const res2 = await g2.request.get(`/api/public/slots?eventTypeId=${host.eventTypeId}&from=${day2}T00:00:00Z&to=${day2}T23:59:59Z&tz=UTC`);
  const offered2: string[] = ((await res2.json()).slots ?? []).map((s: { startsAt: string }) => new Date(s.startsAt).toISOString());
  expect(offered2).toContain(b2.starts_at.toISOString());
  await host.ctx.close();
});

test("recurring series: configure in the UI, book 3 weekly sessions, see the dates, cancel one then the series", async ({ browser }) => {
  const host = await setupHost(browser);

  // ---- host turns on "Book a series" in the event-type form (verifies the existing field persists)
  await host.page.goto(`/dashboard/event-types/${host.eventTypeId}`);
  await expect(host.page.getByLabel("Event name")).toBeVisible({ timeout: 30_000 });
  const meetingLink = host.page.getByLabel("Meeting link"); // DB-fallback event types start as "custom link" without a value
  if (await meetingLink.isVisible()) await meetingLink.fill("https://meet.example.com/e2e");
  await host.page.getByRole("tab", { name: "Advanced" }).click();
  await host.page.getByLabel("Book a series").click();
  await host.page.getByLabel("Number of sessions").fill("3");
  await host.page.getByRole("button", { name: "Save changes" }).click();
  await expect.poll(async () => (await q("select recurrence from event_type where id=$1", [host.eventTypeId]))[0]!.recurrence, { timeout: 30_000 })
    .toEqual({ count: 3, interval: "week" });

  // ---- guest sees "3 weekly sessions" with the dates before submitting
  const g = await (await browser.newContext({ timezoneId: "America/New_York" })).newPage();
  const email = `${uid("g")}@${E2E_EMAIL_DOMAIN}`;
  await pickSlot(g, host, 0);
  await expect(g.getByTestId("series-summary")).toContainText("3 weekly sessions");
  const preview = g.getByTestId("series-preview");
  await expect(preview).toContainText("3 weekly sessions");
  await expect(preview.locator("li")).toHaveCount(3);
  await fillForm(g, "Sam Series", email);
  await g.getByRole("button", { name: "Schedule 3 sessions" }).click();
  await expect(g.getByRole("heading", { name: "You are scheduled" })).toBeVisible({ timeout: 30_000 });
  await expect(g.getByTestId("series-confirmation").locator("li")).toHaveCount(3);
  const token = await manageToken(g);

  const rows = await q("select b.* from booking b join invitee i on i.booking_id=b.id where i.email=$1 order by b.starts_at", [email]);
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map((r) => r.series_id)).size).toBe(1);
  expect(rows[0].series_id).toBeTruthy();
  expect(rows.map((r) => r.status)).toEqual(["confirmed", "confirmed", "confirmed"]);
  expect(+rows[1].starts_at - +rows[0].starts_at).toBe(7 * 86_400_000);
  expect(+rows[2].starts_at - +rows[1].starts_at).toBe(7 * 86_400_000);
  // one confirmation email for the whole series, reminders for every session
  await expect.poll(async () => (await q<{ kind: string }>("select n.kind from notification_log n where n.booking_id = any($1::uuid[]) and n.kind in ('confirmation')", [rows.map((r) => r.id)])).length, { timeout: 45_000 }).toBe(1);
  await expect.poll(async () => (await q("select 1 from reminder where booking_id = any($1::uuid[])", [rows.map((r) => r.id)])).length, { timeout: 30_000 }).toBeGreaterThan(2);

  // ---- manage page: series listed; cancel just this session, then the whole series
  await g.goto(`/booking/${token}`);
  await expect(g.getByTestId("series-list").locator("li")).toHaveCount(3);
  await g.getByRole("button", { name: "Cancel this session" }).click();
  await g.getByRole("button", { name: "Yes, cancel meeting" }).click();
  await expect(g.getByText(/This meeting was cancelled/)).toBeVisible({ timeout: 30_000 });
  expect((await q<{ status: string }>("select status from booking where id = any($1::uuid[]) order by starts_at", [rows.map((r) => r.id)])).map((r) => r.status)).toEqual(["cancelled", "confirmed", "confirmed"]);
  await g.getByRole("button", { name: "Cancel entire series" }).click();
  await g.getByRole("button", { name: "Yes, cancel the series" }).click();
  await expect.poll(async () => (await q<{ status: string }>("select status from booking where id = any($1::uuid[]) order by starts_at", [rows.map((r) => r.id)])).map((r) => r.status), { timeout: 30_000 })
    .toEqual(["cancelled", "cancelled", "cancelled"]);
  await host.ctx.close();
});
