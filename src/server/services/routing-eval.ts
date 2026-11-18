/**
 * Pure routing-form model + evaluator. No DB / server-only imports: also used in the browser
 * (live conditional field visibility on the public page).
 */
import { z } from "zod";

export const FIELD_TYPES = ["short_text", "long_text", "email", "phone", "dropdown", "radio", "checkbox"] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const OPERATORS = ["eq", "neq", "contains", "in", "gt", "lt"] as const;
export type Operator = (typeof OPERATORS)[number];
export const OPTION_TYPES: FieldType[] = ["dropdown", "radio", "checkbox"];

export type Answers = Record<string, string | string[]>;

const condition = z.object({
  field: z.string().min(1).max(64),
  op: z.enum(OPERATORS),
  /** `in` takes a list (stored as array); every other operator takes a string. */
  value: z.union([z.string().max(500), z.array(z.string().max(500)).max(50)]),
});
export type Condition = z.infer<typeof condition>;

const conditionGroup = z.object({ match: z.enum(["all", "any"]).default("all"), conditions: z.array(condition).max(20) });
export type ConditionGroup = z.infer<typeof conditionGroup>;

export const fieldSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "Field key must be lowercase letters, digits or _ and start with a letter"),
  label: z.string().trim().min(1, "Label is required").max(200),
  type: z.enum(FIELD_TYPES),
  required: z.boolean().default(false),
  options: z.array(z.string().trim().min(1).max(200)).max(50).optional(),
  /** Field is shown only when this group matches (references EARLIER fields only). */
  visibleWhen: conditionGroup.optional(),
});
export type RoutingField = z.infer<typeof fieldSchema>;

export const destinationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("event"), eventTypeId: z.string().uuid() }),
  z.object({ type: z.literal("url"), url: z.string().trim().max(2000) }),
  z.object({ type: z.literal("message"), title: z.string().trim().max(200).optional(), message: z.string().trim().min(1, "Message is required").max(2000) }),
]);
export type Destination = z.infer<typeof destinationSchema>;

export const ruleSchema = z.object({
  match: z.enum(["all", "any"]).default("all"),
  when: z.array(condition).min(1, "A rule needs at least one condition").max(20),
  destination: destinationSchema,
});
export type RoutingRule = z.infer<typeof ruleSchema>;

export const formConfigSchema = z.object({
  fields: z.array(fieldSchema).min(1, "Add at least one field").max(30),
  rules: z.array(ruleSchema).max(50).default([]),
  fallback: destinationSchema.nullable().default(null),
});
export type FormConfig = z.infer<typeof formConfigSchema>;

export interface ConfigIssue { path: string; message: string }

const isHttpUrl = (u: string) => { try { const p = new URL(u); return p.protocol === "http:" || p.protocol === "https:"; } catch { return false; } };

/** Semantic validation beyond shape. Returns [] when the config is sound. */
export function validateConfig(c: FormConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const byId = new Map<string, number>();
  c.fields.forEach((f, i) => {
    if (byId.has(f.id)) issues.push({ path: `fields.${i}.id`, message: `Duplicate field key "${f.id}"` });
    if (OPTION_TYPES.includes(f.type)) {
      const o = f.options ?? [];
      if (o.length === 0) issues.push({ path: `fields.${i}.options`, message: "Add at least one option" });
      if (new Set(o.map((x) => x.toLowerCase())).size !== o.length) issues.push({ path: `fields.${i}.options`, message: "Options must be unique" });
    }
    const prior = new Map(c.fields.slice(0, i).map((x) => [x.id, x]));
    f.visibleWhen?.conditions.forEach((cd, j) => {
      if (!prior.has(cd.field)) issues.push({ path: `fields.${i}.visibleWhen.${j}`, message: "Visibility can only depend on an earlier field" });
      else checkCondition(cd, prior.get(cd.field)!, `fields.${i}.visibleWhen.${j}`, issues);
    });
    if (f.visibleWhen && f.visibleWhen.conditions.length === 0) issues.push({ path: `fields.${i}.visibleWhen`, message: "Add a condition or remove the visibility rule" });
    if (!byId.has(f.id)) byId.set(f.id, i);
  });
  const all = new Map(c.fields.map((f) => [f.id, f]));
  const dest = (d: Destination, path: string) => {
    if (d.type === "url" && !isHttpUrl(d.url)) issues.push({ path, message: "Enter a valid http(s) URL" });
  };
  c.rules.forEach((r, i) => {
    r.when.forEach((cd, j) => {
      const f = all.get(cd.field);
      if (!f) issues.push({ path: `rules.${i}.when.${j}`, message: "Condition references an unknown field" });
      else checkCondition(cd, f, `rules.${i}.when.${j}`, issues);
    });
    dest(r.destination, `rules.${i}.destination`);
  });
  if (c.fallback) dest(c.fallback, "fallback");
  return issues;
}

function checkCondition(cd: Condition, f: RoutingField, path: string, issues: ConfigIssue[]) {
  if (cd.op === "in" && !Array.isArray(cd.value)) issues.push({ path, message: '"is one of" needs a list of values' });
  if (cd.op !== "in" && Array.isArray(cd.value)) issues.push({ path, message: "This operator takes a single value" });
  if ((cd.op === "gt" || cd.op === "lt") && !Array.isArray(cd.value) && !Number.isFinite(Number(cd.value))) {
    issues.push({ path, message: "Greater/less than needs a number" });
  }
  if ((cd.op === "gt" || cd.op === "lt") && ["email", "phone", "checkbox"].includes(f.type)) {
    issues.push({ path, message: "Greater/less than does not apply to this field type" });
  }
  if (cd.op === "in" && Array.isArray(cd.value) && cd.value.length === 0) issues.push({ path, message: "Add at least one value" });
}

// ───────── evaluation

const norm = (s: string) => s.trim().toLowerCase();
const empty = (v: string | string[] | undefined) => v === undefined || (Array.isArray(v) ? v.length === 0 : v.trim() === "");

function asList(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return (Array.isArray(v) ? v : [v]).map(norm).filter((x) => x !== "");
}

/** Evaluate one condition against answers. Missing/blank answers match nothing except `neq`. */
export function evalCondition(cd: Condition, answers: Answers): boolean {
  const a = answers[cd.field];
  const have = asList(a);
  const want = Array.isArray(cd.value) ? cd.value.map(norm) : [norm(cd.value)];
  switch (cd.op) {
    case "eq": {
      if (empty(a)) return false;
      const w = want[0] ?? "";
      return have.length === 1 ? have[0] === w : have.includes(w); // multi-select: "includes this option"
    }
    case "neq": {
      if (empty(a)) return true;
      const w = want[0] ?? "";
      return have.length === 1 ? have[0] !== w : !have.includes(w);
    }
    case "contains": {
      const w = want[0] ?? "";
      if (w === "") return false;
      return have.some((h) => h.includes(w));
    }
    case "in":
      return have.some((h) => want.includes(h));
    case "gt":
    case "lt": {
      if (empty(a) || Array.isArray(a)) return false;
      const n = Number(a.trim()), w = Number(want[0]);
      if (!Number.isFinite(n) || !Number.isFinite(w) || a.trim() === "") return false;
      return cd.op === "gt" ? n > w : n < w;
    }
  }
}

export function evalGroup(g: { match: "all" | "any"; conditions: Condition[] }, answers: Answers): boolean {
  if (g.conditions.length === 0) return false;
  return g.match === "any" ? g.conditions.some((c) => evalCondition(c, answers)) : g.conditions.every((c) => evalCondition(c, answers));
}

/** Fields currently visible given answers (a field hidden by an earlier hidden field's answer stays hidden). */
export function visibleFields(fields: RoutingField[], answers: Answers): RoutingField[] {
  const out: RoutingField[] = [];
  const effective: Answers = {};
  for (const f of fields) {
    if (f.visibleWhen && f.visibleWhen.conditions.length && !evalGroup(f.visibleWhen, effective)) continue;
    out.push(f);
    const v = answers[f.id];
    if (v !== undefined) effective[f.id] = v;
  }
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9 ()\-.]{6,25}$/;

export interface ValidationResult { ok: boolean; errors: Record<string, string>; answers: Answers }

/** Validate + sanitize answers: only visible fields are kept; hidden-field answers are dropped. */
export function validateAnswers(fields: RoutingField[], raw: Answers): ValidationResult {
  const errors: Record<string, string> = {};
  const clean: Answers = {};
  for (const f of visibleFields(fields, raw)) {
    const v = raw[f.id];
    if (empty(v)) { if (f.required) errors[f.id] = "This field is required"; continue; }
    if (f.type === "checkbox") {
      const arr = Array.isArray(v) ? v : [v as string];
      if (arr.some((x) => !(f.options ?? []).includes(x))) { errors[f.id] = "Invalid selection"; continue; }
      clean[f.id] = [...new Set(arr)];
      continue;
    }
    if (Array.isArray(v)) { errors[f.id] = "Invalid value"; continue; }
    const s = v!.trim();
    if (s.length > (f.type === "long_text" ? 2000 : 500)) { errors[f.id] = "Too long"; continue; }
    if (f.type === "email" && !EMAIL_RE.test(s)) { errors[f.id] = "Enter a valid email address"; continue; }
    if (f.type === "phone" && !PHONE_RE.test(s)) { errors[f.id] = "Enter a valid phone number"; continue; }
    if ((f.type === "dropdown" || f.type === "radio") && !(f.options ?? []).includes(s)) { errors[f.id] = "Invalid selection"; continue; }
    clean[f.id] = s;
  }
  return { ok: Object.keys(errors).length === 0, errors, answers: clean };
}

export type RouteOutcome =
  | { source: "rule"; ruleIndex: number; destination: Destination }
  | { source: "fallback"; destination: Destination }
  | { source: "none"; destination: null };

/** First matching rule wins; otherwise fallback; otherwise none. */
export function evaluateRoute(config: Pick<FormConfig, "rules" | "fallback">, answers: Answers): RouteOutcome {
  for (let i = 0; i < config.rules.length; i++) {
    const r = config.rules[i]!;
    if (evalGroup({ match: r.match, conditions: r.when }, answers)) return { source: "rule", ruleIndex: i, destination: r.destination };
  }
  if (config.fallback) return { source: "fallback", destination: config.fallback };
  return { source: "none", destination: null };
}

/** Best-effort prefill values for the booking page. */
export function extractPrefill(fields: RoutingField[], answers: Answers): { name?: string; email?: string } {
  const str = (v: string | string[] | undefined) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const emailField = fields.find((f) => f.type === "email" && str(answers[f.id]));
  const nameField = fields.find((f) => f.type === "short_text" && /name/i.test(`${f.id} ${f.label}`) && str(answers[f.id]));
  return { name: nameField ? str(answers[nameField.id]) : undefined, email: emailField ? str(answers[emailField.id]) : undefined };
}
