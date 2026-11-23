import { and, count, eq, inArray, isNull } from "drizzle-orm";
import { db as defaultDb, schema, type Db } from "@/server/db";
import { AppError } from "@/server/errors";

const { subscriptions, subscriptionPlans, organizations, eventTypes, availabilitySchedules } = schema;

/** Numeric limits are "max N"; -1 or a missing key means unlimited. Boolean limits are feature flags. */
export type PlanMetric = "maxEventTypes" | "maxSchedules";
export type PlanFeature = string;
export type PlanSubject = { userId: string; orgId?: undefined } | { orgId: string; userId?: undefined };

export type PlanLimits = Record<string, number | boolean>;

/** Resolve the effective limits for a user or an organization. Active subscription wins, then org.planId, then plan "free". */
export async function getPlanLimits(subject: PlanSubject, db: Db = defaultDb): Promise<{ planId: string | null; limits: PlanLimits }> {
  const where = subject.orgId ? eq(subscriptions.organizationId, subject.orgId) : eq(subscriptions.userId, subject.userId!);
  const subs = await db
    .select({ planId: subscriptions.planId, status: subscriptions.status, limits: subscriptionPlans.limits })
    .from(subscriptions)
    .innerJoin(subscriptionPlans, eq(subscriptionPlans.id, subscriptions.planId))
    .where(and(where, inArray(subscriptions.status, ["active", "trialing"])))
    .orderBy(subscriptions.createdAt);
  const latest = subs[subs.length - 1];
  if (latest) return { planId: latest.planId, limits: latest.limits };

  let planId = "free";
  if (subject.orgId) {
    const [org] = await db.select({ planId: organizations.planId }).from(organizations).where(eq(organizations.id, subject.orgId)).limit(1);
    if (org) planId = org.planId;
  }
  const [plan] = await db
    .select({ id: subscriptionPlans.id, limits: subscriptionPlans.limits })
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.id, planId))
    .limit(1);
  return plan ? { planId: plan.id, limits: plan.limits } : { planId: null, limits: {} };
}

export async function currentUsage(subject: PlanSubject, metric: PlanMetric, db: Db = defaultDb): Promise<number> {
  switch (metric) {
    case "maxEventTypes": {
      const owner = subject.orgId ? eq(eventTypes.organizationId, subject.orgId) : eq(eventTypes.ownerUserId, subject.userId!);
      const [r] = await db
        .select({ n: count() })
        .from(eventTypes)
        .where(and(owner, isNull(eventTypes.deletedAt), isNull(eventTypes.archivedAt), eq(eventTypes.isOneOff, false)));
      return r?.n ?? 0;
    }
    case "maxSchedules": {
      if (!subject.userId) return 0;
      const [r] = await db.select({ n: count() }).from(availabilitySchedules).where(eq(availabilitySchedules.userId, subject.userId));
      return r?.n ?? 0;
    }
  }
}

const LABELS: Record<PlanMetric, string> = { maxEventTypes: "event types", maxSchedules: "availability schedules" };

/** Plan limits are NOT enforced unless ENFORCE_PLAN_LIMITS=true (billing pages and plan data are unaffected). */
const enforced = () => process.env.ENFORCE_PLAN_LIMITS === "true";

/**
 * Throws AppError("PLAN_LIMIT", ..., 402) when creating one more resource would exceed the plan limit.
 * `adding` is how many new resources are about to be created (default 1).
 */
export async function assertWithinPlan(subject: PlanSubject, metric: PlanMetric, db: Db = defaultDb, adding = 1): Promise<void> {
  if (!enforced()) return;
  const { limits, planId } = await getPlanLimits(subject, db);
  const limit = limits[metric];
  if (typeof limit !== "number" || limit < 0) return; // unlimited / not configured
  const used = await currentUsage(subject, metric, db);
  if (used + adding > limit) {
    throw new AppError(
      "PLAN_LIMIT",
      `Your ${planId ?? "current"} plan allows up to ${limit} ${LABELS[metric]}. Upgrade your plan to add more.`,
      402,
    );
  }
}

/** Boolean feature flag check (e.g. "paymentsEnabled"). A missing flag is treated as allowed. */
export async function assertFeature(subject: PlanSubject, feature: PlanFeature, db: Db = defaultDb): Promise<void> {
  if (!enforced()) return;
  const { limits, planId } = await getPlanLimits(subject, db);
  if (limits[feature] === false) {
    throw new AppError("PLAN_FEATURE", `"${feature}" is not available on the ${planId ?? "current"} plan.`, 402);
  }
}

