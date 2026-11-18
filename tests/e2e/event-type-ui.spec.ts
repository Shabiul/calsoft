import { test, expect } from "@playwright/test";
import { cleanupUsers, createEventTypeViaUi, ensureAvailability, q, signupHost } from "./helpers";

test.afterAll(async () => { await cleanupUsers(); });

// Known app bug (docs/TESTING.md): /dashboard/event-types/new crashes server-side, so this fails until fixed.
test("host can create an event type through the UI", async ({ page }) => {
  test.setTimeout(60_000);
  const { email } = await signupHost(page);
  await ensureAvailability(page, email);
  const et = await createEventTypeViaUi(page);
  expect((await q("select 1 from event_type e join \"user\" u on u.id=e.owner_user_id where u.email=$1 and e.slug=$2", [email, et.slug])).length).toBe(1);
});

