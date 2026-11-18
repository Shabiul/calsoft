import { test, expect, type BrowserContext } from "@playwright/test";
import { DateTime } from "luxon";
import { cleanupUsers, fillForm, pickSlot, q, setupHost, submitBooking, uid, E2E_EMAIL_DOMAIN, type Host } from "./helpers";

test.describe.configure({ mode: "serial" });

let host: Host;
let hostCtx: BrowserContext;

test.beforeAll(async ({ browser }) => {
  const h = await setupHost(browser);
  host = h; hostCtx = h.ctx;
});
test.afterAll(async () => { await hostCtx?.close(); await cleanupUsers(); });

const gmail = () => `${uid("g")}@${E2E_EMAIL_DOMAIN}`;

test("concurrency: two guests book the same slot, exactly one wins", async ({ browser }) => {
  const mk = async (name: string) => {
    const ctx = await browser.newContext({ timezoneId: "UTC" });
    const page = await ctx.newPage();
    const label = await pickSlot(page, host, 3);
    const email = gmail();
    await fillForm(page, name, email);
    return { ctx, page, label, email };
  };
  const a = await mk("Alice Racer");
  const b = await mk("Bob Racer");
  expect(a.label).toBe(b.label);
  await Promise.all([submitBooking(a.page), submitBooking(b.page)]);

  const ok = (p: typeof a.page) => p.getByRole("heading", { name: "You are scheduled" }).isVisible();
  await expect.poll(async () => (await ok(a.page)) || (await ok(b.page)), { timeout: 30_000 }).toBeTruthy();
  const [okA, okB] = [await ok(a.page), await ok(b.page)];
  expect(okA !== okB, `exactly one confirms (A=${okA}, B=${okB})`).toBeTruthy();
  const loser = okA ? b.page : a.page;
  await expect(loser.getByRole("alert").filter({ hasText: /just taken|no longer available/i })).toBeVisible({ timeout: 20_000 });

  const rows = await q("select status from booking where host_user_id=$1 and status='confirmed' and exists(select 1 from invitee i where i.booking_id=booking.id and i.email=any($2))", [host.userId, [a.email, b.email]]);
  expect(rows).toHaveLength(1);
  await a.ctx.close(); await b.ctx.close();
});

test("timezones: IST and New York guests see the same instant in local time", async ({ browser }) => {
  const ist = await browser.newContext({ timezoneId: "Asia/Kolkata" });
  const ny = await browser.newContext({ timezoneId: "America/New_York" });
  const pi = await ist.newPage(), pn = await ny.newPage();
  await pickSlot(pi, host, 5);
  const email = gmail();
  await fillForm(pi, "Indra Kolkata", email);
  await submitBooking(pi);
  await expect(pi.getByRole("heading", { name: "You are scheduled" })).toBeVisible({ timeout: 30_000 });
  const [b] = await q("select b.starts_at from booking b join invitee i on i.booking_id=b.id where i.email=$1", [email]);
  const start = DateTime.fromJSDate(b.starts_at, { zone: "utc" });
  const fmt = (z: string) => start.setZone(z).toFormat("h:mm a").toLowerCase();
  expect(fmt("Asia/Kolkata")).not.toBe(fmt("America/New_York"));
  await expect(pi.getByText(fmt("Asia/Kolkata"), { exact: false }).first()).toBeVisible();

  // NY guest: same host page; every slot shown must be a real instant from the API rendered in NY local time
  const from = DateTime.utc();
  const api = await pn.request.get(`/api/public/slots?eventTypeId=${host.eventTypeId}&from=${encodeURIComponent(from.toISO()!)}&to=${encodeURIComponent(from.plus({ days: 20 }).toISO()!)}&tz=America/New_York`);
  const body = await api.json();
  const instants: string[] = (body.data?.slots ?? body.slots).map((x: { startsAt: string }) => x.startsAt);
  expect(instants.length).toBeGreaterThan(0);
  const nyLabels = new Set(instants.map((i) => DateTime.fromISO(i).setZone("America/New_York").toFormat("h:mm a").toLowerCase()));
  const istLabels = new Set(instants.map((i) => DateTime.fromISO(i).setZone("Asia/Kolkata").toFormat("h:mm a").toLowerCase()));
  await pn.goto(`/${host.username}/${host.slug}`);
  await pn.locator('button.mf-day[data-avail="true"]').first().click();
  const labels = (await pn.locator("button.mf-slot").allTextContents()).map((t) => t.trim());
  expect(labels.length).toBeGreaterThan(0);
  for (const l of labels) expect(nyLabels, `NY slot label ${l}`).toContain(l);
  // 09:00-17:00 UTC window: NY (UTC-5/-4) and IST (UTC+5:30) labels differ for every instant
  expect(istLabels.size).toBeGreaterThan(0);
  const ndiff = DateTime.fromISO(instants[0]!).setZone("America/New_York").offset - DateTime.fromISO(instants[0]!).setZone("Asia/Kolkata").offset;
  expect(Math.abs(ndiff)).toBeGreaterThanOrEqual(9 * 60);
  await ist.close(); await ny.close();
});

test("mobile 390px: booking works with no horizontal overflow", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: "UTC" });
  const page = await ctx.newPage();
  const noOverflow = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBeTruthy();
  await page.goto(`/${host.username}/${host.slug}`);
  await noOverflow();
  await page.locator('button.mf-day[data-avail="true"]').first().click();
  await expect(page.locator("button.mf-slot").first()).toBeVisible();
  await page.locator("button.mf-slot").last().click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await noOverflow();
  await fillForm(page, "Mia Mobile", gmail());
  await submitBooking(page);
  await expect(page.getByRole("heading", { name: "You are scheduled" })).toBeVisible({ timeout: 30_000 });
  await noOverflow();
  await ctx.close();
});

test("dark mode smoke: public page and login render dark with no console errors", async ({ browser }) => {
  const ctx = await browser.newContext({ colorScheme: "dark" });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const url of [`/${host.username}/${host.slug}`, "/login"]) {
    await page.goto(url);
    await page.waitForLoadState("networkidle");
    const lum = await page.evaluate(() => {
      const m = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g)!.map(Number);
      return (0.2126 * m[0]! + 0.7152 * m[1]! + 0.0722 * m[2]!) / 255;
    });
    expect(lum, `${url} background luminance in dark scheme`).toBeLessThan(0.5);
  }
  expect(errors).toEqual([]);
  await ctx.close();
});
