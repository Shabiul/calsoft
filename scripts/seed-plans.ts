/**
 * Idempotent default plan seed. Pricing and limits live in the DB (subscription_plan), never in the frontend.
 * Numeric limits: -1 = unlimited. Boolean limits are feature flags. priceMonthly is in minor units (cents).
 * Run: npx tsx scripts/seed-plans.ts   (re-running updates names/limits/prices; edit values in the DB or here freely)
 */
import { config } from "dotenv";
config({ path: ".env.local" });
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { subscriptionPlans } from "../src/server/db/schema";

const PLANS = [
  { id: "free", name: "Free", priceMonthly: 0, limits: { maxEventTypes: 1, maxSchedules: 1, maxTeamMembers: 1, maxCalendars: 1, maxWorkflows: 0, maxRoutingForms: 0, maxWebhooks: 0, groupEvents: false, roundRobin: false, collective: false, payments: false, customBranding: false, removeBranding: false, apiAccess: false, analytics: false, sso: false } },
  { id: "starter", name: "Starter", priceMonthly: 800, limits: { maxEventTypes: 5, maxSchedules: 3, maxTeamMembers: 1, maxCalendars: 3, maxWorkflows: 3, maxRoutingForms: 1, maxWebhooks: 2, groupEvents: true, roundRobin: false, collective: false, payments: true, customBranding: true, removeBranding: false, apiAccess: false, analytics: false, sso: false } },
  { id: "professional", name: "Professional", priceMonthly: 1600, limits: { maxEventTypes: -1, maxSchedules: 10, maxTeamMembers: 1, maxCalendars: 6, maxWorkflows: 20, maxRoutingForms: 5, maxWebhooks: 10, groupEvents: true, roundRobin: false, collective: false, payments: true, customBranding: true, removeBranding: true, apiAccess: true, analytics: true, sso: false } },
  { id: "teams", name: "Teams", priceMonthly: 2000, limits: { maxEventTypes: -1, maxSchedules: -1, maxTeamMembers: 50, maxCalendars: 10, maxWorkflows: -1, maxRoutingForms: -1, maxWebhooks: 50, groupEvents: true, roundRobin: true, collective: true, payments: true, customBranding: true, removeBranding: true, apiAccess: true, analytics: true, sso: false } },
  { id: "enterprise", name: "Enterprise", priceMonthly: 0, limits: { maxEventTypes: -1, maxSchedules: -1, maxTeamMembers: -1, maxCalendars: -1, maxWorkflows: -1, maxRoutingForms: -1, maxWebhooks: -1, groupEvents: true, roundRobin: true, collective: true, payments: true, customBranding: true, removeBranding: true, apiAccess: true, analytics: true, sso: true } },
];

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  for (const p of PLANS) {
    await db.insert(subscriptionPlans).values({ ...p, currency: "USD", isActive: true })
      .onConflictDoUpdate({ target: subscriptionPlans.id, set: { name: p.name, priceMonthly: p.priceMonthly, limits: p.limits } });
  }
  console.log(`seeded ${PLANS.length} plans`);
  await pool.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
