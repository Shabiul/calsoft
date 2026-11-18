import { z } from "zod";

export const EVENT_KINDS = ["one_on_one", "group", "collective", "round_robin"] as const;
export const LOCATION_TYPES = ["google_meet", "zoom", "teams", "custom_url", "in_person", "phone", "invitee_phone"] as const;
export const QUESTION_TYPES = ["short_text", "long_text", "email", "phone", "dropdown", "radio", "checkbox"] as const;
export const OPTION_QUESTION_TYPES = ["dropdown", "radio", "checkbox"] as const;
export const TEAM_KINDS = ["collective", "round_robin"] as const;

export type EventKind = (typeof EVENT_KINDS)[number];
export type LocationType = (typeof LOCATION_TYPES)[number];
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const KIND_LABELS: Record<EventKind, string> = {
  one_on_one: "One-on-one",
  group: "Group",
  collective: "Collective",
  round_robin: "Round robin",
};
export const KIND_HELP: Record<EventKind, string> = {
  one_on_one: "One host meets one invitee.",
  group: "One host meets several invitees at the same time.",
  collective: "All required hosts attend together.",
  round_robin: "Bookings rotate across team hosts.",
};
export const LOCATION_LABELS: Record<LocationType, string> = {
  google_meet: "Google Meet",
  zoom: "Zoom",
  teams: "Microsoft Teams",
  custom_url: "Custom link",
  in_person: "In person",
  phone: "Host calls invitee",
  invitee_phone: "Invitee calls host",
};
export const LOCATIONS_NEEDING_VALUE: LocationType[] = ["custom_url", "in_person", "phone", "invitee_phone"];

export const isTeamKind = (k: EventKind) => (TEAM_KINDS as readonly string[]).includes(k);

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, "Slug is required")
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Lowercase letters, numbers and single hyphens only");

export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "event"
  );
}

const optInt = (min: number, max: number) => z.number().int().min(min).max(max).nullable();
const emptyToNull = (v: unknown) => (typeof v === "string" && v.trim() === "" ? null : v);

export const questionSchema = z
  .object({
    id: z.string().uuid().optional(),
    label: z.string().trim().min(1, "Question label is required").max(200),
    type: z.enum(QUESTION_TYPES),
    options: z.array(z.string().trim().min(1).max(100)).max(30).nullable().optional(),
    required: z.boolean().default(false),
  })
  .superRefine((q, ctx) => {
    if ((OPTION_QUESTION_TYPES as readonly string[]).includes(q.type)) {
      if (!q.options || q.options.length < 1) ctx.addIssue({ code: "custom", path: ["options"], message: "Add at least one option" });
      else if (new Set(q.options.map((o) => o.toLowerCase())).size !== q.options.length)
        ctx.addIssue({ code: "custom", path: ["options"], message: "Options must be unique" });
    }
  });
export type QuestionInput = z.infer<typeof questionSchema>;

export const hostSchema = z.object({
  userId: z.string().min(1),
  priority: z.number().int().min(0).max(1000).default(0),
  weight: z.number().int().min(1).max(1000).default(1),
  isRequired: z.boolean().default(true),
});
export type HostInput = z.infer<typeof hostSchema>;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a #RRGGBB color");
const urlOrNull = z.preprocess(emptyToNull, z.string().trim().url("Enter a full URL, e.g. https://example.com").max(500).nullable().optional());

export const pageSettingsSchema = z.object({
  brandColor: z.preprocess(emptyToNull, hexColor.nullable().optional()),
  logoUrl: urlOrNull,
  headline: z.string().trim().max(160).nullable().optional(),
  successMessage: z.string().trim().max(1000).nullable().optional(),
});

export const eventTypeInputSchema = z
  .object({
    organizationId: z.string().uuid().nullable().default(null),
    title: z.string().trim().min(1, "Name is required").max(120),
    slug: slugSchema,
    description: z.string().trim().max(5000).nullable().optional(),
    kind: z.enum(EVENT_KINDS).default("one_on_one"),
    durationMinutes: z.number().int().min(5).max(24 * 60),
    locationType: z.enum(LOCATION_TYPES).default("google_meet"),
    locationValue: z.string().trim().max(500).nullable().optional(),
    bufferBeforeMinutes: z.number().int().min(0).max(240).default(0),
    bufferAfterMinutes: z.number().int().min(0).max(240).default(0),
    minNoticeMinutes: z.number().int().min(0).max(60 * 24 * 90).default(240),
    maxHorizonDays: z.number().int().min(1).max(730).default(60),
    slotIntervalMinutes: optInt(5, 480).optional(),
    dailyLimit: optInt(1, 1000).optional(),
    weeklyLimit: optInt(1, 5000).optional(),
    capacity: z.number().int().min(1).max(1000).default(1),
    scheduleId: z.string().uuid().nullable().optional(),
    requiresConfirmation: z.boolean().default(false),
    cancellationPolicy: z.string().trim().max(2000).nullable().optional(),
    allowReschedule: z.boolean().default(true),
    minCancelNoticeMinutes: z.number().int().min(0).max(60 * 24 * 30).default(0),
    color: z.preprocess(emptyToNull, hexColor.nullable().optional()),
    redirectUrl: urlOrNull,
    priceAmount: z.number().int().min(1).max(100_000_000).nullable().optional(), // minor units
    priceCurrency: z.preprocess(emptyToNull, z.string().trim().toUpperCase().length(3, "3-letter currency code").nullable().optional()),
    paymentProvider: z.enum(["stripe", "razorpay"]).nullable().optional(),
    reminders: z.array(z.number().int().min(1).max(60 * 24 * 30)).max(5).default([1440, 60]),
    recurrence: z
      .object({ count: z.number().int().min(2).max(52), interval: z.enum(["week", "month"]) })
      .nullable()
      .optional(),
    isActive: z.boolean().default(true),
    isOneOff: z.boolean().default(false),
    hosts: z.array(hostSchema).max(100).default([]),
    questions: z.array(questionSchema).max(30).default([]),
    pageSettings: pageSettingsSchema.nullable().optional(),
  })
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (LOCATIONS_NEEDING_VALUE.includes(v.locationType) && !v.locationValue?.trim())
      issue("locationValue", "This location type needs a value (link, address or phone)");
    if (v.locationType === "custom_url" && v.locationValue && !/^https?:\/\//i.test(v.locationValue))
      issue("locationValue", "Custom link must start with http:// or https://");
    if (v.kind !== "group" && v.capacity !== 1) issue("capacity", "Capacity above 1 is only for group events");
    if (v.kind === "group" && v.capacity < 2) issue("capacity", "Group events need a capacity of at least 2");
    if (isTeamKind(v.kind) && !v.organizationId) issue("kind", "Team event kinds require an organization");
    if (v.organizationId && v.hosts.length === 0) issue("hosts", "Choose at least one host");
    if (v.kind === "collective" && v.hosts.length > 0 && !v.hosts.some((h) => h.isRequired))
      issue("hosts", "A collective event needs at least one required host");
    if (new Set(v.hosts.map((h) => h.userId)).size !== v.hosts.length) issue("hosts", "A host was added twice");
    if (v.priceAmount != null && !v.priceCurrency) issue("priceCurrency", "Choose a currency for the price");
    if (v.priceAmount != null && !v.paymentProvider) issue("paymentProvider", "Choose a payment provider");
    if (v.recurrence && v.kind === "group") issue("recurrence", "Group events cannot be recurring");
    if (v.recurrence && v.priceAmount != null) issue("recurrence", "Paid events cannot be recurring (remove the price or the series)");
    if (v.dailyLimit != null && v.weeklyLimit != null && v.weeklyLimit < v.dailyLimit)
      issue("weeklyLimit", "Weekly limit cannot be lower than daily limit");
  });
export type EventTypeInput = z.infer<typeof eventTypeInputSchema>;
export type EventTypeFormValues = z.input<typeof eventTypeInputSchema>;

export const idSchema = z.string().uuid();
