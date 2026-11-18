import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Pool } from "pg";

export const DATABASE_URL = process.env.DATABASE_URL ?? "postgres://meetflow:meetflow@localhost:54329/meetflow";
export const pool = new Pool({ connectionString: DATABASE_URL, max: 2 });

const RUN = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
let n = 0;
export const uid = (p: string) => `${p}${RUN}${n++}`;
export const E2E_EMAIL_DOMAIN = "e2e.meetflow.test";
export const E2E_LIKE = `%@${E2E_EMAIL_DOMAIN}`;

export type Host = { username: string; email: string; slug: string; title: string; eventTypeId: string; userId: string; password: string };

export async function q<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params)).rows as T[];
}

/** Host registers through the UI. */
export async function signupHost(page: Page) {
  const username = uid("h");
  const email = `${username}@${E2E_EMAIL_DOMAIN}`;
  const password = "E2e-Passw0rd!";
  await page.goto("/signup");
  await page.getByLabel("Full name").fill(`E2E Host ${username}`);
  await page.getByLabel("Work email").fill(email);
  await page.locator("#username").fill(username);
  await expect(page.getByText("Available", { exact: true })).toBeVisible();
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 30_000 });
  return { username, email, password };
}

const scheduleCount = async (email: string) =>
  (await q("select 1 from availability_schedule s join \"user\" u on u.id=s.user_id where u.email=$1", [email])).length;

/** Host sets availability through the UI (creates a Mon-Fri 9-5 schedule if signup did not). */
export async function ensureAvailability(page: Page, email: string) {
  await page.goto("/dashboard/availability");
  await expect(page.getByRole("heading", { name: "Availability" }).first()).toBeVisible();
  if ((await scheduleCount(email)) === 0) {
    await page.getByRole("button", { name: /Create schedule|New schedule/ }).first().click();
    await page.getByLabel("Name").fill("Working hours");
    await page.getByRole("button", { name: "Create schedule" }).last().click();
    await expect.poll(() => scheduleCount(email)).toBe(1);
  }
  const rules = await q<{ c: string }>(
    "select count(*)::text c from availability_rule r join availability_schedule s on s.id=r.schedule_id join \"user\" u on u.id=s.user_id where u.email=$1", [email]);
  expect(Number(rules[0]!.c)).toBeGreaterThan(0);
}

/** Strict UI creation. */
export async function createEventTypeViaUi(page: Page) {
  const title = `Intro call ${uid("t")}`;
  const slug = uid("s");
  await page.goto("/dashboard/event-types/new");
  await page.getByLabel("Event name").fill(title);
  await page.getByLabel("Link slug").fill(slug);
  await page.getByRole("button", { name: "Create event type" }).click();
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 30_000 });
  return { title, slug };
}

/**
 * Creates an event type via the UI; if the "new event type" page itself is broken (known app bug, see
 * docs/TESTING.md) falls back to a DB insert so downstream flows are still exercised. The strict UI
 * check lives in its own test.
 */
export async function createEventType(page: Page, email?: string) {
  await page.goto("/dashboard/event-types/new");
  const ok = await page.getByLabel("Event name").isVisible({ timeout: 10_000 }).catch(() => false);
  if (ok) return createEventTypeViaUi(page);
  test.info().annotations.push({ type: "fallback", description: "event-types/new UI broken; created event type via DB" });
  const title = `Intro call ${uid("t")}`;
  const slug = uid("s");
  await q("insert into event_type (owner_user_id, slug, title, location_type) select id, $2, $3, 'custom_url' from \"user\" where email=$1", [email, slug, title]);
  return { title, slug };
}

/** Full host setup via UI. Caller owns (and should close) host context. */
export async function setupHost(browser: Browser): Promise<Host & { ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ timezoneId: "UTC", permissions: ["clipboard-read", "clipboard-write"] });
  const page = await ctx.newPage();
  const { username, email, password } = await signupHost(page);
  await ensureAvailability(page, email);
  const et = await createEventType(page, email);
  const row = (await q<{ id: string; user_id: string }>(
    "select e.id, e.owner_user_id user_id from event_type e join \"user\" u on u.id=e.owner_user_id where u.username=$1 and e.slug=$2", [username, et.slug]))[0];
  expect(row, "event type row exists").toBeTruthy();
  return { username, email, password, slug: et.slug, title: et.title, eventTypeId: row!.id, userId: row!.user_id, ctx, page };
}

/** Guest walks the public page to the details form. Returns the chosen slot label. */
export async function pickSlot(page: Page, host: Pick<Host, "username" | "slug">, slotIndex = 0) {
  await page.goto(`/${host.username}/${host.slug}`);
  const day = page.locator('button.mf-day[data-avail="true"]').first();
  await expect(day).toBeVisible({ timeout: 30_000 });
  await day.click();
  await expect(page.locator("button.mf-slot").first()).toBeVisible();
  const count = await page.locator("button.mf-slot").count();
  const slot = page.locator("button.mf-slot").nth(Math.min(slotIndex, count - 1)); // first day may be partial
  const label = (await slot.textContent())!.trim();
  await slot.click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  return label;
}

export async function fillForm(page: Page, name: string, email: string) {
  await expect(page.getByRole("heading", { name: "Enter your details" })).toBeVisible();
  await page.getByLabel(/^Name/).fill(name);
  await page.getByLabel(/^Email/).fill(email);
  await page.getByRole("checkbox").first().check();
}

export const submitBooking = (page: Page) => page.getByRole("button", { name: /Schedule event|Request booking/ }).click();

export async function manageToken(page: Page): Promise<string> {
  const href = await page.getByRole("link", { name: /Reschedule or cancel/ }).getAttribute("href");
  return href!.split("/booking/")[1]!;
}

/** Remove everything created by e2e users (bookings are normally never hard-deleted; tests clean up directly). */
export async function cleanupUsers(like = E2E_LIKE) {
  const sub = `select id from "user" where email like $1`;
  const stmts = [
    `delete from notification_log where booking_id in (select id from booking where host_user_id in (${sub}))`,
    `delete from booking where host_user_id in (${sub})`,
    `delete from event_type where owner_user_id in (${sub})`,
    `delete from contact where owner_user_id in (${sub})`,
    `delete from "user" where email like $1`,
  ];
  for (const s of stmts) {
    try { await pool.query(s, [like]); } catch (e) { console.warn("cleanup:", (e as Error).message.slice(0, 160)); }
  }
}
