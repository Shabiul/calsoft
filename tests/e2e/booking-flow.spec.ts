import { test, expect, type Page } from "@playwright/test";
import { DateTime } from "luxon";
import {
  cleanupUsers, createEventType, ensureAvailability, fillForm, manageToken, q, signupHost, submitBooking, uid, E2E_EMAIL_DOMAIN,
} from "./helpers";

test.describe.configure({ mode: "serial" });
test.afterAll(async () => { await cleanupUsers(); });

test("full flow: host setup -> guest books -> dashboard -> ICS -> reschedule -> cancel", async ({ browser, baseURL }) => {
  // ---- host: register, availability, event type, public link
  const hostCtx = await browser.newContext({ timezoneId: "UTC", permissions: ["clipboard-read", "clipboard-write"] });
  const host = await hostCtx.newPage();
  const { username, email: hostEmail } = await signupHost(host);
  await ensureAvailability(host, hostEmail);
  const et = await createEventType(host, hostEmail);

  await host.goto("/dashboard/event-types");
  await host.getByRole("button", { name: "Copy link" }).first().click();
  await expect(host.getByText("Link copied")).toBeVisible();
  let link = `${baseURL}/${username}/${et.slug}`;
  try {
    const clip = await host.evaluate(() => navigator.clipboard.readText());
    expect(clip).toContain(`/${username}/${et.slug}`);
    link = clip;
  } catch { /* clipboard read not available; link toast verified */ }

  // calendar connections are honest: no real providers
  await host.goto("/dashboard/integrations");
  await expect(host.getByText("Requires credentials").first()).toBeVisible();

  const [{ id: eventTypeId }] = await q<{ id: string }>("select e.id from event_type e join \"user\" u on u.id=e.owner_user_id where u.username=$1 and e.slug=$2", [username, et.slug]);

  // ---- guest (separate context, no login) books
  const guestEmail = `${uid("g")}@${E2E_EMAIL_DOMAIN}`;
  const guestCtx = await browser.newContext({ timezoneId: "Asia/Kolkata" });
  const guest = await guestCtx.newPage();
  await guest.goto(link.replace(/^https?:\/\/[^/]+/, ""));
  await expect(guest.getByRole("heading", { name: et.title })).toBeVisible();
  const day = guest.locator('button.mf-day[data-avail="true"]').first();
  await day.click();
  await guest.locator("button.mf-slot").first().click();
  await guest.getByRole("button", { name: "Next", exact: true }).click();
  await fillForm(guest, "Gina Guest", guestEmail);
  await submitBooking(guest);
  await expect(guest.getByRole("heading", { name: "You are scheduled" })).toBeVisible({ timeout: 30_000 });
  const token1 = await manageToken(guest);

  // ---- DB: booking + invitee
  const [b1] = await q("select b.* from booking b join invitee i on i.booking_id=b.id where i.email=$1", [guestEmail]);
  expect(b1.status).toBe("confirmed");
  expect(["Asia/Kolkata", "Asia/Calcutta"]).toContain(b1.invitee_time_zone); // ICU may report the legacy alias
  const inv = await q("select * from invitee where booking_id=$1", [b1.id]);
  expect(inv).toHaveLength(1);
  expect(inv[0].name).toBe("Gina Guest");

  // ---- notification_log rows (worker must be running)
  await expect.poll(async () => (await q("select 1 from notification_log where booking_id=$1", [b1.id])).length, { timeout: 45_000 }).toBeGreaterThan(0);
  const recipients = (await q<{ recipient: string }>("select recipient from notification_log where booking_id=$1", [b1.id])).map((r) => r.recipient);
  expect(recipients).toContain(guestEmail);

  // ---- ICS
  const ics = await guest.request.get(`/api/public/ics/${token1}`);
  expect(ics.status()).toBe(200);
  expect(ics.headers()["content-type"]).toContain("text/calendar");
  const icsBody = await ics.text();
  expect(icsBody).toContain("BEGIN:VCALENDAR");
  expect(icsBody).toContain("BEGIN:VEVENT");
  expect(icsBody).toContain(DateTime.fromJSDate(b1.starts_at, { zone: "utc" }).toFormat("yyyyMMdd'T'HHmmss'Z'"));

  // ---- host dashboard shows it
  await host.goto("/dashboard/scheduled");
  await expect(host.getByText("Gina Guest").first()).toBeVisible();
  await expect(host.getByRole("link").filter({ hasText: et.title }).first()).toBeVisible();

  // ---- reschedule through manage link (pick the 2nd slot of the first day)
  await guest.goto(`/booking/${token1}`);
  await guest.getByRole("button", { name: "Reschedule", exact: true }).click();
  await guest.locator('button.mf-day[data-avail="true"]').first().click();
  await guest.locator("button.mf-slot").nth(1).click();
  await guest.getByRole("button", { name: "Next", exact: true }).click();
  await guest.getByRole("button", { name: "Confirm reschedule" }).click();
  await expect(guest.getByRole("heading", { name: /scheduled|rescheduled/i }).first()).toBeVisible({ timeout: 30_000 });
  const token2 = await manageToken(guest);
  expect(token2).not.toBe(token1);

  const rows = await q("select * from booking where host_user_id=$1 order by created_at", [b1.host_user_id]);
  expect(rows).toHaveLength(2);
  const old = rows.find((r) => r.id === b1.id)!;
  const fresh = rows.find((r) => r.id !== b1.id)!;
  expect(old.status).toBe("rescheduled");
  expect(fresh.status).toBe("confirmed");
  expect(fresh.rescheduled_from_id).toBe(b1.id);
  expect(+fresh.starts_at).not.toBe(+old.starts_at);
  const hist = (await q<{ type: string }>("select type from booking_event where booking_id=$1", [b1.id])).map((r) => r.type);
  expect(hist).toContain("rescheduled");

  // old slot freed: bookable again via public slots API
  const from = DateTime.fromJSDate(old.starts_at, { zone: "utc" }).startOf("day");
  const res = await guest.request.get(`/api/public/slots?eventTypeId=${eventTypeId}&from=${encodeURIComponent(from.toISO()!)}&to=${encodeURIComponent(from.plus({ days: 1 }).toISO()!)}&tz=UTC`);
  expect(res.ok()).toBeTruthy();
  const slots: string[] = ((await res.json()).data?.slots ?? (await res.json()).slots ?? []).map((s: { startsAt: string }) => DateTime.fromISO(s.startsAt).toMillis().toString());
  expect(slots, "old slot is bookable again").toContain(String(+old.starts_at));
  // history page of old booking tells the user it moved
  await guest.goto(`/booking/${token1}`);
  await expect(guest.getByText(/moved to a new time/)).toBeVisible();

  // ---- cancel with reason
  await guest.goto(`/booking/${token2}`);
  await guest.getByRole("button", { name: /Cancel meeting/ }).click();
  await guest.getByLabel(/Reason for cancelling/).fill("Plans changed");
  await guest.getByRole("button", { name: "Yes, cancel meeting" }).click();
  await expect(guest.getByText(/This meeting was cancelled/)).toBeVisible({ timeout: 30_000 });
  const [c] = await q("select * from booking where id=$1", [fresh.id]);
  expect(c.status).toBe("cancelled");
  expect(c.cancel_reason).toBe("Plans changed");
  expect(c.cancelled_at).toBeTruthy();
  expect((await q("select 1 from booking where host_user_id=$1", [b1.host_user_id])).length).toBe(2); // rows preserved
  await host.goto("/dashboard/scheduled?tab=cancelled");
  await expect(host.getByText("Gina Guest").first()).toBeVisible();

  await hostCtx.close(); await guestCtx.close();
});

async function newGuestPage(browser: import("@playwright/test").Browser, tz: string, extra: Record<string, unknown> = {}) {
  const ctx = await browser.newContext({ timezoneId: tz, ...extra });
  return { ctx, page: await ctx.newPage() };
}
export { newGuestPage };
export type { Page };
