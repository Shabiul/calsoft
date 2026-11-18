/**
 * MeetFlow authoritative schema. All appointment timestamps are timestamptz (UTC).
 * Booking integrity is enforced by an EXCLUDE constraint (see drizzle/0001_constraints.sql):
 *   no two active bookings may overlap for the same host (incl. buffers) -> double-booking impossible at DB level.
 * Better Auth tables (user/session/account/verification) live here too so one migration owns everything.
 */
import { sql } from "drizzle-orm";
import {
  pgTable, text, uuid, timestamp, integer, boolean, jsonb, pgEnum, index, uniqueIndex,
  primaryKey, date, time, customType,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
const tstz = (n: string) => timestamp(n, { withTimezone: true });

/** Raw tstzrange column, maintained by DB trigger/generated expression in 0001_constraints.sql */
export const tstzrange = customType<{ data: string }>({ dataType: () => "tstzrange" });

// ───────── enums
export const orgRole = pgEnum("org_role", ["owner", "admin", "member"]);
export const platformRole = pgEnum("platform_role", ["user", "superadmin"]);
export const eventKind = pgEnum("event_kind", ["one_on_one", "group", "collective", "round_robin"]);
export const locationType = pgEnum("location_type", ["google_meet", "zoom", "teams", "custom_url", "in_person", "phone", "invitee_phone"]);
export const bookingStatus = pgEnum("booking_status", ["pending_payment", "pending_confirmation", "confirmed", "cancelled", "rescheduled", "completed", "no_show", "expired"]);
export const providerEnum = pgEnum("calendar_provider", ["google", "microsoft"]);
export const paymentStatus = pgEnum("payment_status", ["requires_payment", "pending", "paid", "failed", "refunded", "partially_refunded"]);
export const jobStatus = pgEnum("delivery_status", ["queued", "sent", "failed", "dead"]);

// ───────── identity (Better Auth compatible)
export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(), updatedAt: updatedAt(),
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
  username: text("username").unique(),
  phone: text("phone"), bio: text("bio"), country: text("country"),
  language: text("language").notNull().default("en"),
  timeZone: text("time_zone").notNull().default("UTC"),
  dateFormat: text("date_format").notNull().default("MM/dd/yyyy"),
  timeFormat: text("time_format").notNull().default("12h"),
  platformRole: platformRole("platform_role").notNull().default("user"),
  status: text("status").notNull().default("active"), // active | suspended
  brandColor: text("brand_color"), logoUrl: text("logo_url"),
  deletedAt: tstz("deleted_at"),
});
export const sessions = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: tstz("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: createdAt(), updatedAt: updatedAt(),
  ipAddress: text("ip_address"), userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
});
export const accounts = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(), providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  accessToken: text("access_token"), refreshToken: text("refresh_token"), idToken: text("id_token"),
  accessTokenExpiresAt: tstz("access_token_expires_at"), refreshTokenExpiresAt: tstz("refresh_token_expires_at"),
  scope: text("scope"), password: text("password"),
  createdAt: createdAt(), updatedAt: updatedAt(),
});
export const verifications = pgTable("verification", {
  id: text("id").primaryKey(), identifier: text("identifier").notNull(), value: text("value").notNull(),
  expiresAt: tstz("expires_at").notNull(), createdAt: createdAt(), updatedAt: updatedAt(),
});
export const twoFactors = pgTable("two_factor", {
  id: text("id").primaryKey(), secret: text("secret").notNull(), backupCodes: text("backup_codes").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // columns required by better-auth >=1.7 two-factor plugin
  verified: boolean("verified").default(true),
  failedVerificationCount: integer("failed_verification_count").default(0),
  lockedUntil: tstz("locked_until"),
});

export const organizations = pgTable("organization", {
  id: id(), name: text("name").notNull(), slug: text("slug").notNull().unique(),
  logoUrl: text("logo_url"), brandColor: text("brand_color"),
  planId: text("plan_id").notNull().default("free"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(), updatedAt: updatedAt(), deletedAt: tstz("deleted_at"),
});
export const organizationMembers = pgTable("organization_member", {
  id: id(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: orgRole("role").notNull().default("member"),
  permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("org_member_uq").on(t.organizationId, t.userId), index("org_member_user_idx").on(t.userId)]);
export const invitations = pgTable("invitation", {
  id: id(),
  organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull(), role: orgRole("role").notNull().default("member"),
  tokenHash: text("token_hash").notNull().unique(),
  invitedBy: text("invited_by").references(() => users.id), expiresAt: tstz("expires_at").notNull(),
  acceptedAt: tstz("accepted_at"), createdAt: createdAt(),
});

// ───────── availability
export const availabilitySchedules = pgTable("availability_schedule", {
  id: id(), userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(), timeZone: text("time_zone").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [index("avail_sched_user_idx").on(t.userId)]);
/** Weekly recurring intervals in the schedule's local time. weekday: 0=Sunday..6=Saturday */
export const availabilityRules = pgTable("availability_rule", {
  id: id(), scheduleId: uuid("schedule_id").notNull().references(() => availabilitySchedules.id, { onDelete: "cascade" }),
  weekday: integer("weekday").notNull(), startTime: time("start_time").notNull(), endTime: time("end_time").notNull(),
}, (t) => [index("avail_rule_sched_idx").on(t.scheduleId)]);
/** Date-specific override. Zero intervals (isUnavailable) = whole day off. */
export const availabilityOverrides = pgTable("availability_override", {
  id: id(), scheduleId: uuid("schedule_id").notNull().references(() => availabilitySchedules.id, { onDelete: "cascade" }),
  date: date("date").notNull(), isUnavailable: boolean("is_unavailable").notNull().default(false),
  startTime: time("start_time"), endTime: time("end_time"),
}, (t) => [index("avail_ovr_sched_date_idx").on(t.scheduleId, t.date)]);
export const blockedTimes = pgTable("blocked_time", {
  id: id(), userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  startsAt: tstz("starts_at").notNull(), endsAt: tstz("ends_at").notNull(), reason: text("reason"),
  createdAt: createdAt(),
}, (t) => [index("blocked_user_time_idx").on(t.userId, t.startsAt)]);

// ───────── event types
export const eventTypes = pgTable("event_type", {
  id: id(),
  ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(), title: text("title").notNull(), description: text("description"),
  kind: eventKind("kind").notNull().default("one_on_one"),
  durationMinutes: integer("duration_minutes").notNull().default(30),
  locationType: locationType("location_type").notNull().default("google_meet"),
  locationValue: text("location_value"),
  bufferBeforeMinutes: integer("buffer_before_minutes").notNull().default(0),
  bufferAfterMinutes: integer("buffer_after_minutes").notNull().default(0),
  minNoticeMinutes: integer("min_notice_minutes").notNull().default(240),
  maxHorizonDays: integer("max_horizon_days").notNull().default(60),
  slotIntervalMinutes: integer("slot_interval_minutes"),
  dailyLimit: integer("daily_limit"), weeklyLimit: integer("weekly_limit"),
  capacity: integer("capacity").notNull().default(1), // group events
  scheduleId: uuid("schedule_id").references(() => availabilitySchedules.id, { onDelete: "set null" }),
  requiresConfirmation: boolean("requires_confirmation").notNull().default(false),
  cancellationPolicy: text("cancellation_policy"), allowReschedule: boolean("allow_reschedule").notNull().default(true),
  minCancelNoticeMinutes: integer("min_cancel_notice_minutes").notNull().default(0),
  color: text("color"), redirectUrl: text("redirect_url"),
  priceAmount: integer("price_amount"), // minor units
  priceCurrency: text("price_currency"), paymentProvider: text("payment_provider"),
  recurrence: jsonb("recurrence").$type<{ count: number; interval: "week" | "month" } | null>(),
  reminders: jsonb("reminders").$type<number[]>().notNull().default([1440, 60]), // minutes before
  isActive: boolean("is_active").notNull().default(true), isOneOff: boolean("is_one_off").notNull().default(false),
  archivedAt: tstz("archived_at"), deletedAt: tstz("deleted_at"),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  uniqueIndex("event_slug_user_uq").on(t.ownerUserId, t.slug).where(sql`${t.ownerUserId} is not null and ${t.deletedAt} is null`),
  uniqueIndex("event_slug_org_uq").on(t.organizationId, t.slug).where(sql`${t.organizationId} is not null and ${t.deletedAt} is null`),
]);
export const eventHosts = pgTable("event_host", {
  eventTypeId: uuid("event_type_id").notNull().references(() => eventTypes.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  priority: integer("priority").notNull().default(0), weight: integer("weight").notNull().default(1),
  isRequired: boolean("is_required").notNull().default(true), // collective
}, (t) => [primaryKey({ columns: [t.eventTypeId, t.userId] })]);
export const eventQuestions = pgTable("event_question", {
  id: id(), eventTypeId: uuid("event_type_id").notNull().references(() => eventTypes.id, { onDelete: "cascade" }),
  label: text("label").notNull(), type: text("type").notNull(), // short_text|long_text|email|phone|dropdown|radio|checkbox
  options: jsonb("options").$type<string[]>(), required: boolean("required").notNull().default(false),
  position: integer("position").notNull().default(0),
});
export const bookingPageSettings = pgTable("booking_page_setting", {
  eventTypeId: uuid("event_type_id").primaryKey().references(() => eventTypes.id, { onDelete: "cascade" }),
  brandColor: text("brand_color"), logoUrl: text("logo_url"), headline: text("headline"), successMessage: text("success_message"),
});

// ───────── bookings
export const contacts = pgTable("contact", {
  id: id(), ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull(), name: text("name"), phone: text("phone"), timeZone: text("time_zone"),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex("contact_owner_email_uq").on(t.ownerUserId, t.email), index("contact_org_idx").on(t.organizationId)]);
export const contactNotes = pgTable("contact_note", {
  id: id(), contactId: uuid("contact_id").notNull().references(() => contacts.id, { onDelete: "cascade" }),
  authorId: text("author_id").references(() => users.id), body: text("body").notNull(), createdAt: createdAt(),
});

export const bookings = pgTable("booking", {
  id: id(),
  eventTypeId: uuid("event_type_id").notNull().references(() => eventTypes.id),
  hostUserId: text("host_user_id").notNull().references(() => users.id),
  organizationId: uuid("organization_id").references(() => organizations.id),
  startsAt: tstz("starts_at").notNull(), endsAt: tstz("ends_at").notNull(),
  /** Host-blocked window incl. buffers; basis of the exclusion constraint. */
  blockStart: tstz("block_start").notNull(), blockEnd: tstz("block_end").notNull(),
  status: bookingStatus("status").notNull().default("confirmed"),
  inviteeTimeZone: text("invitee_time_zone").notNull(), hostTimeZone: text("host_time_zone").notNull(),
  locationType: locationType("location_type"), meetingUrl: text("meeting_url"),
  externalEventIds: jsonb("external_event_ids").$type<Record<string, string>>().notNull().default({}),
  idempotencyKey: text("idempotency_key").unique(),
  rescheduledFromId: uuid("rescheduled_from_id"),
  cancelledAt: tstz("cancelled_at"), cancelReason: text("cancel_reason"), cancelledBy: text("cancelled_by"),
  hostNotes: text("host_notes"), manageTokenHash: text("manage_token_hash").unique(),
  exclusiveSlot: boolean("exclusive_slot").notNull().default(true),
  seriesId: uuid("series_id"), holdExpiresAt: tstz("hold_expires_at"),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [
  index("booking_host_time_idx").on(t.hostUserId, t.startsAt),
  index("booking_event_time_idx").on(t.eventTypeId, t.startsAt),
  index("booking_org_idx").on(t.organizationId, t.startsAt),
  index("booking_status_idx").on(t.status),
]);
export const invitees = pgTable("invitee", {
  id: id(), bookingId: uuid("booking_id").notNull().references(() => bookings.id, { onDelete: "cascade" }),
  contactId: uuid("contact_id").references(() => contacts.id),
  name: text("name").notNull(), email: text("email").notNull(), phone: text("phone"),
  cancelledAt: tstz("cancelled_at"), createdAt: createdAt(),
}, (t) => [index("invitee_booking_idx").on(t.bookingId), index("invitee_email_idx").on(t.email)]);
export const inviteeAnswers = pgTable("invitee_answer", {
  id: id(), inviteeId: uuid("invitee_id").notNull().references(() => invitees.id, { onDelete: "cascade" }),
  questionId: uuid("question_id").references(() => eventQuestions.id, { onDelete: "set null" }),
  question: text("question").notNull(), answer: text("answer").notNull(),
});
export const bookingEvents = pgTable("booking_event", { // audit/history; bookings are never hard-deleted
  id: id(), bookingId: uuid("booking_id").notNull().references(() => bookings.id, { onDelete: "cascade" }),
  type: text("type").notNull(), actor: text("actor"), data: jsonb("data").$type<Record<string, unknown>>(), createdAt: createdAt(),
});

// ───────── calendars
export const connectedCalendars = pgTable("connected_calendar", {
  id: id(), userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: providerEnum("provider").notNull(), externalAccountId: text("external_account_id").notNull(),
  email: text("email"),
  /** AES-256-GCM encrypted JSON {accessToken, refreshToken, expiresAt} */
  credentialsEnc: text("credentials_enc").notNull(),
  status: text("status").notNull().default("active"), // active | needs_reauth | error
  lastError: text("last_error"), createdAt: createdAt(),
}, (t) => [uniqueIndex("conn_cal_uq").on(t.userId, t.provider, t.externalAccountId)]);
export const calendars = pgTable("calendar", {
  id: id(), connectedCalendarId: uuid("connected_calendar_id").notNull().references(() => connectedCalendars.id, { onDelete: "cascade" }),
  externalId: text("external_id").notNull(), name: text("name").notNull(),
  checkConflicts: boolean("check_conflicts").notNull().default(true),
  isDestination: boolean("is_destination").notNull().default(false),
}, (t) => [uniqueIndex("calendar_ext_uq").on(t.connectedCalendarId, t.externalId)]);
export const calendarSyncStates = pgTable("calendar_sync_state", {
  calendarId: uuid("calendar_id").primaryKey().references(() => calendars.id, { onDelete: "cascade" }),
  syncToken: text("sync_token"), channelId: text("channel_id"), channelResourceId: text("channel_resource_id"),
  channelExpiresAt: tstz("channel_expires_at"), lastSyncedAt: tstz("last_synced_at"), lastError: text("last_error"),
});
/** Cached busy intervals from external calendars (refreshed by sync; re-verified live at booking time). */
export const calendarBusy = pgTable("calendar_busy", {
  id: id(), calendarId: uuid("calendar_id").notNull().references(() => calendars.id, { onDelete: "cascade" }),
  externalEventId: text("external_event_id").notNull(), startsAt: tstz("starts_at").notNull(), endsAt: tstz("ends_at").notNull(),
}, (t) => [uniqueIndex("calbusy_uq").on(t.calendarId, t.externalEventId), index("calbusy_time_idx").on(t.calendarId, t.startsAt)]);

/** Video conferencing OAuth connections (Zoom). Credentials AES-256-GCM encrypted like connected_calendar. */
export const videoConnections = pgTable("video_connection", {
  id: id(), userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(), // zoom
  externalAccountId: text("external_account_id").notNull(), email: text("email"),
  credentialsEnc: text("credentials_enc").notNull(),
  status: text("status").notNull().default("active"), lastError: text("last_error"), createdAt: createdAt(),
}, (t) => [uniqueIndex("video_conn_uq").on(t.userId, t.provider)]);

// ───────── payments
export const payments = pgTable("payment", {
  id: id(), bookingId: uuid("booking_id").notNull().references(() => bookings.id),
  provider: text("provider").notNull(), providerOrderId: text("provider_order_id"), providerPaymentId: text("provider_payment_id"),
  amount: integer("amount").notNull(), currency: text("currency").notNull(), status: paymentStatus("status").notNull().default("requires_payment"),
  createdAt: createdAt(), updatedAt: updatedAt(),
}, (t) => [uniqueIndex("payment_provider_order_uq").on(t.provider, t.providerOrderId)]);
export const refunds = pgTable("refund", {
  id: id(), paymentId: uuid("payment_id").notNull().references(() => payments.id), amount: integer("amount").notNull(),
  providerRefundId: text("provider_refund_id"), reason: text("reason"), createdAt: createdAt(),
});

/** Provider webhook dedupe + processing log (payments feature). One row per (provider, provider event id). */
export const paymentWebhookEvents = pgTable("payment_webhook_event", {
  id: id(), provider: text("provider").notNull(), eventId: text("event_id").notNull(), type: text("type").notNull(),
  status: text("status").notNull().default("received"), // received | processed | failed | ignored
  error: text("error"), receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
}, (t) => [uniqueIndex("payment_webhook_event_uq").on(t.provider, t.eventId)]);
/** Maps a subscription_plan to the provider-side plan/price id used for subscription checkout. */
export const planProviderPrices = pgTable("plan_provider_price", {
  planId: text("plan_id").notNull().references(() => subscriptionPlans.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(), providerPriceId: text("provider_price_id").notNull(),
}, (t) => [primaryKey({ columns: [t.planId, t.provider] })]);

// ───────── notifications, workflows
export const reminders = pgTable("reminder", {
  id: id(), bookingId: uuid("booking_id").notNull().references(() => bookings.id, { onDelete: "cascade" }),
  minutesBefore: integer("minutes_before").notNull(), sendAt: tstz("send_at").notNull(), sentAt: tstz("sent_at"),
}, (t) => [uniqueIndex("reminder_uq").on(t.bookingId, t.minutesBefore), index("reminder_due_idx").on(t.sendAt)]);
export const notificationLogs = pgTable("notification_log", {
  id: id(), bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "set null" }),
  kind: text("kind").notNull(), recipient: text("recipient").notNull(), status: jobStatus("status").notNull().default("queued"),
  dedupeKey: text("dedupe_key").unique(), attempts: integer("attempts").notNull().default(0), error: text("error"),
  createdAt: createdAt(), sentAt: tstz("sent_at"),
});
export const notificationTemplates = pgTable("notification_template", {
  id: id(), ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), subject: text("subject").notNull(), body: text("body").notNull(),
});
export const workflows = pgTable("workflow", {
  id: id(), ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(), trigger: text("trigger").notNull(), eventTypeIds: jsonb("event_type_ids").$type<string[]>(),
  isActive: boolean("is_active").notNull().default(true), createdAt: createdAt(),
});
export const workflowSteps = pgTable("workflow_step", {
  id: id(), workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
  position: integer("position").notNull(), action: text("action").notNull(), offsetMinutes: integer("offset_minutes").notNull().default(0),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
});
export const workflowExecutions = pgTable("workflow_execution", {
  id: id(), workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
  stepId: uuid("step_id").references(() => workflowSteps.id, { onDelete: "set null" }),
  bookingId: uuid("booking_id").references(() => bookings.id, { onDelete: "cascade" }),
  status: jobStatus("status").notNull().default("queued"), error: text("error"), runAt: tstz("run_at"), createdAt: createdAt(),
});

// ───────── routing forms
export const routingForms = pgTable("routing_form", {
  id: id(), ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  slug: text("slug").notNull(), name: text("name").notNull(),
  fields: jsonb("fields").$type<unknown[]>().notNull().default([]),
  rules: jsonb("rules").$type<unknown[]>().notNull().default([]), // [{when:[{field,op,value}],destination:{type,eventTypeId|url}}]
  fallback: jsonb("fallback").$type<Record<string, unknown> | null>(), createdAt: createdAt(),
}, (t) => [uniqueIndex("routing_slug_uq").on(t.ownerUserId, t.slug)]);

export const routingSubmissions = pgTable("routing_submission", {
  id: id(), formId: uuid("form_id").notNull().references(() => routingForms.id, { onDelete: "cascade" }),
  answers: jsonb("answers").$type<Record<string, string | string[]>>().notNull().default({}),
  /** {type:"event"|"url"|"message"|"none", source:"rule"|"fallback", ruleIndex?, eventTypeId?, url?} */
  outcome: jsonb("outcome").$type<Record<string, unknown>>().notNull().default({}),
  email: text("email"), name: text("name"), createdAt: createdAt(),
}, (t) => [index("routing_sub_form_idx").on(t.formId, t.createdAt)]);

// ───────── platform
export const subscriptionPlans = pgTable("subscription_plan", {
  id: text("id").primaryKey(), name: text("name").notNull(), priceMonthly: integer("price_monthly").notNull().default(0),
  currency: text("currency").notNull().default("USD"),
  limits: jsonb("limits").$type<Record<string, number | boolean>>().notNull().default({}), isActive: boolean("is_active").notNull().default(true),
});
export const subscriptions = pgTable("subscription", {
  id: id(), userId: text("user_id").references(() => users.id), organizationId: uuid("organization_id").references(() => organizations.id),
  planId: text("plan_id").notNull().references(() => subscriptionPlans.id), status: text("status").notNull().default("active"),
  provider: text("provider"), providerSubscriptionId: text("provider_subscription_id"),
  currentPeriodEnd: tstz("current_period_end"), createdAt: createdAt(),
});
export const usageRecords = pgTable("usage_record", {
  id: id(), userId: text("user_id"), organizationId: uuid("organization_id"), metric: text("metric").notNull(),
  period: text("period").notNull(), value: integer("value").notNull().default(0),
}, (t) => [uniqueIndex("usage_uq").on(t.userId, t.organizationId, t.metric, t.period)]);
export const apiKeys = pgTable("api_key", {
  id: id(), userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  name: text("name").notNull(), prefix: text("prefix").notNull(), keyHash: text("key_hash").notNull().unique(),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]), lastUsedAt: tstz("last_used_at"), revokedAt: tstz("revoked_at"), createdAt: createdAt(),
});
export const webhookEndpoints = pgTable("webhook_endpoint", {
  id: id(), userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
  url: text("url").notNull(), secret: text("secret").notNull(), events: jsonb("events").$type<string[]>().notNull(),
  isActive: boolean("is_active").notNull().default(true), createdAt: createdAt(),
});
export const webhookDeliveries = pgTable("webhook_delivery", {
  id: id(), endpointId: uuid("endpoint_id").notNull().references(() => webhookEndpoints.id, { onDelete: "cascade" }),
  event: text("event").notNull(), payload: jsonb("payload").notNull(), status: jobStatus("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0), responseCode: integer("response_code"), error: text("error"),
  createdAt: createdAt(), deliveredAt: tstz("delivered_at"),
});
export const pageViews = pgTable("page_view", {
  id: id(), eventTypeId: uuid("event_type_id").references(() => eventTypes.id, { onDelete: "cascade" }),
  userId: text("user_id"), createdAt: createdAt(),
}, (t) => [index("pv_event_idx").on(t.eventTypeId, t.createdAt)]);
export const auditLogs = pgTable("audit_log", {
  id: id(), actorId: text("actor_id"), organizationId: uuid("organization_id"), action: text("action").notNull(),
  entity: text("entity"), entityId: text("entity_id"), meta: jsonb("meta").$type<Record<string, unknown>>(), ip: text("ip"), createdAt: createdAt(),
}, (t) => [index("audit_created_idx").on(t.createdAt)]);


/** Super-admin editable platform configuration (key/value). Owned by the admin feature. */
export const platformSettings = pgTable("platform_setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedBy: text("updated_by"),
  updatedAt: updatedAt(),
});
