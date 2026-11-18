import { describe, expect, it } from "vitest";
import {
  evalCondition, evaluateRoute, extractPrefill, formConfigSchema, validateAnswers, validateConfig, visibleFields,
  type FormConfig, type RoutingField,
} from "./routing-eval";

const EV = "11111111-1111-4111-8111-111111111111";
const EV2 = "22222222-2222-4222-8222-222222222222";

const fields: RoutingField[] = [
  { id: "name", label: "Your name", type: "short_text", required: true },
  { id: "email", label: "Email", type: "email", required: true },
  { id: "size", label: "Company size", type: "short_text", required: false },
  { id: "topic", label: "Topic", type: "dropdown", required: true, options: ["Sales", "Support", "Other"] },
  { id: "plan", label: "Plan", type: "radio", required: true, options: ["Pro", "Team"], visibleWhen: { match: "all", conditions: [{ field: "topic", op: "eq", value: "Sales" }] } },
  { id: "seats", label: "Seats", type: "short_text", required: true, visibleWhen: { match: "all", conditions: [{ field: "plan", op: "eq", value: "Team" }] } },
  { id: "interests", label: "Interests", type: "checkbox", required: false, options: ["A", "B", "C"] },
];

describe("evalCondition", () => {
  it("eq / neq are case-insensitive and trimmed", () => {
    expect(evalCondition({ field: "topic", op: "eq", value: "sales" }, { topic: " Sales " })).toBe(true);
    expect(evalCondition({ field: "topic", op: "neq", value: "sales" }, { topic: "Support" })).toBe(true);
    expect(evalCondition({ field: "topic", op: "neq", value: "sales" }, { topic: "Sales" })).toBe(false);
  });
  it("missing answers: eq false, neq true", () => {
    expect(evalCondition({ field: "x", op: "eq", value: "a" }, {})).toBe(false);
    expect(evalCondition({ field: "x", op: "neq", value: "a" }, {})).toBe(true);
    expect(evalCondition({ field: "x", op: "contains", value: "a" }, { x: "" })).toBe(false);
  });
  it("contains / in", () => {
    expect(evalCondition({ field: "e", op: "contains", value: "@acme.com" }, { e: "Bob@Acme.com" })).toBe(true);
    expect(evalCondition({ field: "t", op: "in", value: ["a", "b"] }, { t: "B" })).toBe(true);
    expect(evalCondition({ field: "t", op: "in", value: ["a", "b"] }, { t: "c" })).toBe(false);
    expect(evalCondition({ field: "t", op: "in", value: ["a", "b"] }, { t: ["z", "a"] })).toBe(true);
  });
  it("gt / lt numeric only", () => {
    expect(evalCondition({ field: "n", op: "gt", value: "10" }, { n: "11" })).toBe(true);
    expect(evalCondition({ field: "n", op: "gt", value: "10" }, { n: "9" })).toBe(false);
    expect(evalCondition({ field: "n", op: "lt", value: "10" }, { n: "9.5" })).toBe(true);
    expect(evalCondition({ field: "n", op: "lt", value: "10" }, { n: "abc" })).toBe(false);
    expect(evalCondition({ field: "n", op: "lt", value: "10" }, { n: "" })).toBe(false);
  });
  it("multi-select eq means includes", () => {
    expect(evalCondition({ field: "i", op: "eq", value: "b" }, { i: ["A", "B"] })).toBe(true);
    expect(evalCondition({ field: "i", op: "neq", value: "b" }, { i: ["A", "B"] })).toBe(false);
  });
});

describe("visibility / branching", () => {
  it("shows dependent fields only when conditions match, transitively", () => {
    const ids = (a: Record<string, string>) => visibleFields(fields, a).map((f) => f.id);
    expect(ids({ topic: "Support" })).not.toContain("plan");
    expect(ids({ topic: "Sales" })).toContain("plan");
    expect(ids({ topic: "Sales" })).not.toContain("seats");
    expect(ids({ topic: "Sales", plan: "Team" })).toContain("seats");
    expect(ids({ topic: "Support", plan: "Team" })).not.toContain("seats");
  });
  it("hidden required fields are not required and their answers are dropped", () => {
    const r = validateAnswers(fields, { name: "A", email: "a@b.co", topic: "Support", plan: "Team", seats: "5" });
    expect(r.ok).toBe(true);
    expect(r.answers).toEqual({ name: "A", email: "a@b.co", topic: "Support" });
  });
  it("visible required field missing -> error", () => {
    const r = validateAnswers(fields, { name: "A", email: "a@b.co", topic: "Sales" });
    expect(r.ok).toBe(false);
    expect(r.errors.plan).toBeDefined();
    expect(r.errors.seats).toBeUndefined();
  });
});

describe("validateAnswers", () => {
  it("rejects bad email, option outside list, bad checkbox", () => {
    const r = validateAnswers(fields, { name: "A", email: "nope", topic: "Hack", interests: ["Z"] });
    expect(r.errors.email).toBeDefined();
    expect(r.errors.topic).toBeDefined();
    expect(r.errors.interests).toBeDefined();
  });
  it("accepts valid checkbox set and dedupes", () => {
    const r = validateAnswers(fields, { name: "A", email: "a@b.co", topic: "Other", interests: ["A", "A", "C"] });
    expect(r.ok).toBe(true);
    expect(r.answers.interests).toEqual(["A", "C"]);
  });
});

describe("evaluateRoute", () => {
  const cfg: Pick<FormConfig, "rules" | "fallback"> = {
    rules: [
      { match: "all", when: [{ field: "topic", op: "eq", value: "Sales" }, { field: "size", op: "gt", value: "100" }], destination: { type: "event", eventTypeId: EV } },
      { match: "any", when: [{ field: "topic", op: "eq", value: "Sales" }, { field: "email", op: "contains", value: "@vip.com" }], destination: { type: "event", eventTypeId: EV2 } },
      { match: "all", when: [{ field: "topic", op: "eq", value: "Support" }], destination: { type: "url", url: "https://help.example.com" } },
    ],
    fallback: { type: "message", message: "We will email you." },
  };
  it("first match wins (AND)", () => {
    expect(evaluateRoute(cfg, { topic: "Sales", size: "500" })).toMatchObject({ source: "rule", ruleIndex: 0 });
  });
  it("falls through to OR rule", () => {
    expect(evaluateRoute(cfg, { topic: "Sales", size: "5" })).toMatchObject({ source: "rule", ruleIndex: 1 });
    expect(evaluateRoute(cfg, { topic: "Other", email: "x@vip.com" })).toMatchObject({ source: "rule", ruleIndex: 1 });
  });
  it("url rule, fallback, none", () => {
    expect(evaluateRoute(cfg, { topic: "Support" })).toMatchObject({ source: "rule", ruleIndex: 2 });
    expect(evaluateRoute(cfg, { topic: "Other" })).toMatchObject({ source: "fallback" });
    expect(evaluateRoute({ rules: [], fallback: null }, {})).toEqual({ source: "none", destination: null });
  });
});

describe("validateConfig", () => {
  const base = (): FormConfig => formConfigSchema.parse({ fields, rules: [], fallback: null });
  it("accepts a sound config", () => {
    expect(validateConfig(base())).toEqual([]);
  });
  it("flags duplicates, missing options, forward refs, bad url, unknown field", () => {
    const c = base();
    c.fields.push({ ...c.fields[0]! });
    c.fields.push({ id: "pick", label: "Pick", type: "dropdown", required: false, options: [] });
    c.fields.push({ id: "early", label: "E", type: "short_text", required: false, visibleWhen: { match: "all", conditions: [{ field: "later", op: "eq", value: "x" }] } });
    c.fields.push({ id: "later", label: "L", type: "short_text", required: false });
    c.rules.push({ match: "all", when: [{ field: "ghost", op: "eq", value: "1" }], destination: { type: "url", url: "javascript:alert(1)" } });
    c.fallback = { type: "url", url: "ftp://x" };
    const paths = validateConfig(c).map((i) => i.path);
    expect(paths).toContain("fields.7.id");
    expect(paths).toContain("fields.8.options");
    expect(paths).toContain("fields.9.visibleWhen.0");
    expect(paths).toContain("rules.0.when.0");
    expect(paths).toContain("rules.0.destination");
    expect(paths).toContain("fallback");
  });
  it("operator/value shape", () => {
    const c = base();
    c.rules.push({ match: "all", when: [{ field: "size", op: "in", value: "x" }, { field: "size", op: "gt", value: "abc" }], destination: { type: "message", message: "m" } });
    expect(validateConfig(c).length).toBe(2);
  });
  it("schema rejects a rule without conditions", () => {
    expect(formConfigSchema.safeParse({ fields, rules: [{ when: [], destination: { type: "message", message: "m" } }] }).success).toBe(false);
  });
});

describe("extractPrefill", () => {
  it("picks email and name fields", () => {
    expect(extractPrefill(fields, { name: "Ann", email: "ann@x.co" })).toEqual({ name: "Ann", email: "ann@x.co" });
    expect(extractPrefill(fields, {})).toEqual({ name: undefined, email: undefined });
  });
});
