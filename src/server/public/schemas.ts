import { z } from "zod";

export function isValidTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}

export const tzSchema = z.string().min(1).max(64).refine(isValidTimeZone, "Invalid time zone");
const isoSchema = z.iso.datetime({ offset: true });

export const slotsQuerySchema = z.object({
  eventTypeId: z.uuid(),
  from: isoSchema,
  to: isoSchema,
  tz: tzSchema,
  token: z.string().min(16).max(200).optional(),
}).refine((v) => new Date(v.to) > new Date(v.from), { message: "`to` must be after `from`", path: ["to"] })
  .refine((v) => new Date(v.to).getTime() - new Date(v.from).getTime() <= 62 * 86_400_000, { message: "Range too large (max 62 days)", path: ["to"] });

export const inviteeSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  email: z.email("Enter a valid email").max(254).transform((s) => s.toLowerCase()),
  phone: z.string().trim().max(40).optional().transform((s) => (s ? s : undefined)),
  timeZone: tzSchema,
});

export const answersSchema = z.record(z.string().uuid(), z.union([z.string().max(2000), z.array(z.string().max(500)).max(50)]));

export const bookBodySchema = z.object({
  eventTypeId: z.uuid(),
  startsAt: isoSchema,
  invitee: inviteeSchema,
  answers: answersSchema.optional().default({}),
  guests: z.array(z.email().max(254).transform((s) => s.toLowerCase())).max(10).optional().default([]),
  idempotencyKey: z.string().min(8).max(100).regex(/^[A-Za-z0-9._:-]+$/),
  consent: z.literal(true, { error: "You must accept the privacy notice" }),
  embed: z.boolean().optional(),
});
export type BookBody = z.infer<typeof bookBodySchema>;

export const rescheduleBodySchema = z.object({ startsAt: isoSchema, timeZone: tzSchema });
export const cancelBodySchema = z.object({ reason: z.string().trim().max(500).optional(), scope: z.enum(["occurrence", "series"]).optional() });

export type PublicQuestion = { id: string; label: string; type: string; options: string[] | null; required: boolean };

/** Validates answers against the event's questions. Returns normalized answers (with question label) or field errors. */
export function validateAnswers(
  questions: PublicQuestion[],
  answers: Record<string, string | string[]>,
): { ok: true; value: { questionId: string; question: string; answer: string }[] } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const value: { questionId: string; question: string; answer: string }[] = [];
  for (const q of questions) {
    const raw = answers[q.id];
    const arr = Array.isArray(raw) ? raw.map((s) => s.trim()).filter(Boolean) : raw && raw.trim() ? [raw.trim()] : [];
    if (arr.length === 0) {
      if (q.required) errors[q.id] = "This field is required";
      continue;
    }
    if (q.type !== "checkbox" && arr.length > 1) { errors[q.id] = "Only one answer allowed"; continue; }
    const opts = q.options ?? [];
    if ((q.type === "dropdown" || q.type === "radio" || q.type === "checkbox") && opts.length && !arr.every((a) => opts.includes(a))) {
      errors[q.id] = "Choose one of the listed options"; continue;
    }
    if (q.type === "email" && !z.email().safeParse(arr[0]).success) { errors[q.id] = "Enter a valid email"; continue; }
    if (q.type === "phone" && !/^[+()\-.\s\d]{5,30}$/.test(arr[0]!)) { errors[q.id] = "Enter a valid phone number"; continue; }
    value.push({ questionId: q.id, question: q.label, answer: arr.join(", ") });
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, value };
}
