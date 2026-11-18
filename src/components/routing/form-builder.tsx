"use client";
import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, Input, Label, Textarea } from "@/components/ui";
import { saveFormAction } from "@/app/(app)/dashboard/routing-forms/actions";
import {
  FIELD_TYPES, OPERATORS, OPTION_TYPES, formConfigSchema, validateConfig,
  type Condition, type Destination, type FieldType, type FormConfig, type Operator, type RoutingField, type RoutingRule,
} from "@/server/services/routing-eval";

const TYPE_LABEL: Record<FieldType, string> = {
  short_text: "Short text", long_text: "Long text", email: "Email", phone: "Phone", dropdown: "Dropdown", radio: "Radio buttons", checkbox: "Checkboxes",
};
const OP_LABEL: Record<Operator, string> = { eq: "is", neq: "is not", contains: "contains", in: "is one of", gt: "is greater than", lt: "is less than" };
const selectCls = "h-9 w-full rounded-md border border-input bg-card px-2 text-sm shadow-sm";

export interface EventOption { id: string; title: string }

const keyFromLabel = (l: string) => l.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[^a-z]+/, "").slice(0, 40);
const moveItem = <T,>(arr: T[], i: number, d: -1 | 1): T[] => {
  const j = i + d;
  if (j < 0 || j >= arr.length) return arr;
  const c = [...arr];
  [c[i], c[j]] = [c[j]!, c[i]!];
  return c;
};

// ───────── conditions
function ConditionRow({ cond, fields, onChange, onRemove, idPrefix }: {
  cond: Condition; fields: RoutingField[]; onChange: (c: Condition) => void; onRemove: () => void; idPrefix: string;
}) {
  const f = fields.find((x) => x.id === cond.field);
  const hasOptions = !!f && OPTION_TYPES.includes(f.type) && (f.options?.length ?? 0) > 0;
  const textVal = Array.isArray(cond.value) ? cond.value.join(", ") : cond.value;
  const setOp = (op: Operator) => {
    if (op === "in") onChange({ ...cond, op, value: Array.isArray(cond.value) ? cond.value : cond.value ? [cond.value] : [] });
    else onChange({ ...cond, op, value: Array.isArray(cond.value) ? cond.value[0] ?? "" : cond.value });
  };
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_9rem_1fr_auto] sm:items-center">
      <select aria-label="Field" className={selectCls} value={cond.field} onChange={(e) => onChange({ ...cond, field: e.target.value })}>
        {!f && <option value={cond.field}>{cond.field || "Choose field"}</option>}
        {fields.map((x) => <option key={x.id} value={x.id}>{x.label || x.id}</option>)}
      </select>
      <select aria-label="Operator" className={selectCls} value={cond.op} onChange={(e) => setOp(e.target.value as Operator)}>
        {OPERATORS.map((o) => <option key={o} value={o}>{OP_LABEL[o]}</option>)}
      </select>
      {hasOptions && (cond.op === "eq" || cond.op === "neq") ? (
        <select aria-label="Value" className={selectCls} value={textVal} onChange={(e) => onChange({ ...cond, value: e.target.value })}>
          <option value="">Choose option</option>
          {f!.options!.map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      ) : (
        <Input
          id={`${idPrefix}-v`} aria-label="Value" value={textVal} maxLength={500}
          placeholder={cond.op === "in" ? "a, b, c" : cond.op === "gt" || cond.op === "lt" ? "number" : "value"}
          onChange={(e) => onChange({ ...cond, value: cond.op === "in" ? e.target.value.split(",").map((s) => s.trimStart()) : e.target.value })}
          onBlur={(e) => { if (cond.op === "in") onChange({ ...cond, value: e.target.value.split(",").map((s) => s.trim()).filter(Boolean) }); }}
        />
      )}
      <Button type="button" variant="ghost" size="icon" aria-label="Remove condition" onClick={onRemove}><Trash2 /></Button>
    </div>
  );
}

function ConditionList({ conds, fields, match, onMatch, onChange, idPrefix, addLabel }: {
  conds: Condition[]; fields: RoutingField[]; match: "all" | "any"; onMatch: (m: "all" | "any") => void; onChange: (c: Condition[]) => void; idPrefix: string; addLabel: string;
}) {
  return (
    <div className="space-y-2">
      {conds.length > 1 && (
        <div className="flex items-center gap-2 text-sm">
          <span>Match</span>
          <select aria-label="Match mode" className={`${selectCls} !w-auto`} value={match} onChange={(e) => onMatch(e.target.value as "all" | "any")}>
            <option value="all">all conditions (AND)</option><option value="any">any condition (OR)</option>
          </select>
        </div>
      )}
      {conds.map((c, i) => (
        <ConditionRow key={i} idPrefix={`${idPrefix}-${i}`} cond={c} fields={fields}
          onChange={(n) => onChange(conds.map((x, j) => (j === i ? n : x)))} onRemove={() => onChange(conds.filter((_, j) => j !== i))} />
      ))}
      <Button type="button" variant="outline" size="sm" disabled={fields.length === 0}
        onClick={() => onChange([...conds, { field: fields[0]?.id ?? "", op: "eq", value: "" }])}><Plus /> {addLabel}</Button>
    </div>
  );
}

// ───────── destination
function DestinationEditor({ dest, events, onChange, allowNone, idPrefix }: {
  dest: Destination | null; events: EventOption[]; onChange: (d: Destination | null) => void; allowNone?: boolean; idPrefix: string;
}) {
  const type = dest?.type ?? "none";
  const setType = (t: string) => {
    if (t === "none") onChange(null);
    else if (t === "event") onChange({ type: "event", eventTypeId: events[0]?.id ?? "" });
    else if (t === "url") onChange({ type: "url", url: "https://" });
    else onChange({ type: "message", title: "Thanks!", message: "" });
  };
  return (
    <div className="space-y-2">
      <select aria-label="Destination type" className={selectCls} value={type} onChange={(e) => setType(e.target.value)}>
        {allowNone && <option value="none">Show a generic thank-you message</option>}
        <option value="event" disabled={events.length === 0}>Booking page (event type){events.length === 0 ? " - none available" : ""}</option>
        <option value="url">External URL</option>
        <option value="message">Custom message</option>
      </select>
      {dest?.type === "event" && (
        <select aria-label="Event type" className={selectCls} value={dest.eventTypeId} onChange={(e) => onChange({ type: "event", eventTypeId: e.target.value })}>
          {events.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
        </select>
      )}
      {dest?.type === "url" && <Input aria-label="URL" type="url" value={dest.url} maxLength={2000} placeholder="https://example.com" onChange={(e) => onChange({ type: "url", url: e.target.value })} />}
      {dest?.type === "message" && (
        <div className="space-y-2">
          <Input aria-label="Message title" value={dest.title ?? ""} maxLength={200} placeholder="Title" onChange={(e) => onChange({ ...dest, title: e.target.value })} />
          <Textarea id={`${idPrefix}-msg`} aria-label="Message" value={dest.message} maxLength={2000} rows={3} placeholder="What should the visitor see?" onChange={(e) => onChange({ ...dest, message: e.target.value })} />
        </div>
      )}
    </div>
  );
}

// ───────── main
export function FormBuilder({ formId, initial, events, username, origin }: {
  formId: string;
  initial: { name: string; slug: string; config: FormConfig };
  events: EventOption[];
  username: string | null;
  origin: string;
}) {
  const [name, setName] = useState(initial.name);
  const [slug, setSlug] = useState(initial.slug);
  const [fields, setFields] = useState<RoutingField[]>(initial.config.fields);
  const [rules, setRules] = useState<RoutingRule[]>(initial.config.rules);
  const [fallback, setFallback] = useState<Destination | null>(initial.config.fallback);
  const [pending, start] = useTransition();
  const [serverIssues, setServerIssues] = useState<{ path: string; message: string }[]>([]);

  const config = useMemo<FormConfig>(() => ({ fields, rules, fallback }), [fields, rules, fallback]);
  const issues = useMemo(() => {
    const p = formConfigSchema.safeParse(config);
    if (!p.success) return p.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return validateConfig(p.data);
  }, [config]);

  const setField = (i: number, patch: Partial<RoutingField>) => setFields((fs) => fs.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const renameKey = (i: number, next: string) => {
    const old = fields[i]!.id;
    const re = (cs: Condition[]) => cs.map((c) => (c.field === old ? { ...c, field: next } : c));
    setFields((fs) => fs.map((f, j) => {
      const g = j === i ? { ...f, id: next } : f;
      return g.visibleWhen ? { ...g, visibleWhen: { ...g.visibleWhen, conditions: re(g.visibleWhen.conditions) } } : g;
    }));
    setRules((rs) => rs.map((r) => ({ ...r, when: re(r.when) })));
  };
  const removeField = (i: number) => {
    const id = fields[i]!.id;
    setFields((fs) => fs.filter((_, j) => j !== i).map((f) => (f.visibleWhen ? { ...f, visibleWhen: { ...f.visibleWhen, conditions: f.visibleWhen.conditions.filter((c) => c.field !== id) } } : f))
      .map((f) => (f.visibleWhen && f.visibleWhen.conditions.length === 0 ? { ...f, visibleWhen: undefined } : f)));
    setRules((rs) => rs.map((r) => ({ ...r, when: r.when.filter((c) => c.field !== id) })));
  };
  const addField = () => {
    let n = fields.length + 1;
    while (fields.some((f) => f.id === `field_${n}`)) n++;
    setFields([...fields, { id: `field_${n}`, label: "", type: "short_text", required: false }]);
  };
  const setRule = (i: number, patch: Partial<RoutingRule>) => setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const save = () => {
    setServerIssues([]);
    if (issues.length) { toast.error(issues[0]!.message); return; }
    start(async () => {
      const r = await saveFormAction(formId, { name, slug, config });
      if (r.ok) toast.success("Routing form saved");
      else { toast.error(r.error.message); setServerIssues(r.error.issues ?? []); }
    });
  };
  const fieldIssue = (path: string) => [...issues, ...serverIssues].filter((i) => i.path === path || i.path.startsWith(`${path}.`)).map((i) => i.message);
  const err = (path: string) => {
    const m = fieldIssue(path);
    return m.length ? <p className="mt-1 text-xs text-destructive" role="alert">{m[0]}</p> : null;
  };

  return (
    <div className="space-y-6">
      <Card className="space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="rf-name">Form name</Label><Input id="rf-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></div>
          <div className="space-y-1.5">
            <Label htmlFor="rf-slug">URL slug</Label>
            <Input id="rf-slug" value={slug} maxLength={50} onChange={(e) => setSlug(e.target.value.toLowerCase())} />
            {username ? <p className="text-xs text-muted-foreground">Public link: <a className="underline" href={`/r/${username}/${slug}`} target="_blank" rel="noreferrer">{origin}/r/{username}/{slug}</a> (save first to apply slug changes)</p>
              : <p className="text-xs text-warning">Set a username in Settings to publish this form.</p>}
          </div>
        </div>
      </Card>

      <section aria-labelledby="fields-h" className="space-y-3">
        <h2 id="fields-h" className="text-lg font-semibold">Questions</h2>
        {fields.map((f, i) => {
          const prior = fields.slice(0, i);
          return (
            <Card key={i} className="space-y-3 p-4">
              <div className="grid gap-3 sm:grid-cols-[1fr_11rem]">
                <div className="space-y-1.5">
                  <Label htmlFor={`f${i}-label`}>Label</Label>
                  <Input id={`f${i}-label`} value={f.label} maxLength={200} aria-invalid={fieldIssue(`fields.${i}.label`).length > 0}
                    onChange={(e) => {
                      const auto = f.id === keyFromLabel(f.label) || /^field_\d+$/.test(f.id);
                      setField(i, { label: e.target.value });
                      const k = keyFromLabel(e.target.value);
                      if (auto && k && !fields.some((x, j) => j !== i && x.id === k)) renameKey(i, k);
                    }} />
                  {err(`fields.${i}.label`)}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`f${i}-type`}>Type</Label>
                  <select id={`f${i}-type`} className={selectCls} value={f.type}
                    onChange={(e) => { const t = e.target.value as FieldType; setField(i, { type: t, options: OPTION_TYPES.includes(t) ? f.options?.length ? f.options : ["Option 1"] : undefined }); }}>
                    {FIELD_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
                  </select>
                </div>
              </div>
              {OPTION_TYPES.includes(f.type) && (
                <div className="space-y-1.5">
                  <Label htmlFor={`f${i}-opts`}>Options (one per line)</Label>
                  <Textarea id={`f${i}-opts`} rows={3} defaultValue={(f.options ?? []).join("\n")}
                    onChange={(e) => setField(i, { options: e.target.value.split("\n").map((s) => s.trim()).filter(Boolean) })} />
                  {err(`fields.${i}.options`)}
                </div>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-4 text-sm">
                  <label className="flex items-center gap-2"><input type="checkbox" checked={f.required} onChange={(e) => setField(i, { required: e.target.checked })} /> Required</label>
                  <label className="flex items-center gap-2 text-muted-foreground">Key
                    <Input aria-label="Field key" className="h-8 w-40 font-mono text-xs" value={f.id} maxLength={40}
                      onChange={(e) => renameKey(i, e.target.value.toLowerCase())} />
                  </label>
                  <label className={`flex items-center gap-2 ${i === 0 ? "opacity-50" : ""}`}>
                    <input type="checkbox" disabled={i === 0} checked={!!f.visibleWhen}
                      onChange={(e) => setField(i, { visibleWhen: e.target.checked ? { match: "all", conditions: [{ field: prior[prior.length - 1]?.id ?? "", op: "eq", value: "" }] } : undefined })} />
                    Show only when...
                  </label>
                </div>
                <div className="flex gap-1">
                  <Button type="button" variant="ghost" size="icon" aria-label="Move question up" disabled={i === 0} onClick={() => setFields(moveItem(fields, i, -1))}><ArrowUp /></Button>
                  <Button type="button" variant="ghost" size="icon" aria-label="Move question down" disabled={i === fields.length - 1} onClick={() => setFields(moveItem(fields, i, 1))}><ArrowDown /></Button>
                  <Button type="button" variant="ghost" size="icon" aria-label="Remove question" disabled={fields.length === 1} onClick={() => removeField(i)}><Trash2 /></Button>
                </div>
              </div>
              {err(`fields.${i}.id`)}
              {f.visibleWhen && (
                <div className="rounded-lg border bg-muted/40 p-3">
                  <ConditionList idPrefix={`f${i}-vis`} fields={prior} conds={f.visibleWhen.conditions} match={f.visibleWhen.match}
                    onMatch={(m) => setField(i, { visibleWhen: { ...f.visibleWhen!, match: m } })}
                    onChange={(cs) => setField(i, { visibleWhen: cs.length ? { ...f.visibleWhen!, conditions: cs } : undefined })} addLabel="Add condition" />
                  {err(`fields.${i}.visibleWhen`)}
                </div>
              )}
            </Card>
          );
        })}
        {fields.length < 30 && <Button type="button" variant="outline" onClick={addField}><Plus /> Add question</Button>}
        {err("fields")}
      </section>

      <section aria-labelledby="rules-h" className="space-y-3">
        <div>
          <h2 id="rules-h" className="text-lg font-semibold">Routing rules</h2>
          <p className="text-sm text-muted-foreground">Rules run top to bottom; the first one that matches decides where the visitor goes.</p>
        </div>
        {rules.length === 0 && <p className="text-sm text-muted-foreground">No rules yet. Everyone gets the fallback below.</p>}
        {rules.map((r, i) => (
          <Card key={i} className="space-y-3 p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">Rule {i + 1}</h3>
              <div className="flex gap-1">
                <Button type="button" variant="ghost" size="icon" aria-label="Move rule up" disabled={i === 0} onClick={() => setRules(moveItem(rules, i, -1))}><ArrowUp /></Button>
                <Button type="button" variant="ghost" size="icon" aria-label="Move rule down" disabled={i === rules.length - 1} onClick={() => setRules(moveItem(rules, i, 1))}><ArrowDown /></Button>
                <Button type="button" variant="ghost" size="icon" aria-label="Remove rule" onClick={() => setRules(rules.filter((_, j) => j !== i))}><Trash2 /></Button>
              </div>
            </div>
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">If</p>
              <ConditionList idPrefix={`r${i}`} fields={fields} conds={r.when} match={r.match} onMatch={(m) => setRule(i, { match: m })} onChange={(cs) => setRule(i, { when: cs })} addLabel="Add condition" />
              {err(`rules.${i}.when`)}
            </div>
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Then send them to</p>
              <DestinationEditor idPrefix={`r${i}`} dest={r.destination} events={events} onChange={(d) => d && setRule(i, { destination: d })} />
              {err(`rules.${i}.destination`)}
            </div>
          </Card>
        ))}
        <Button type="button" variant="outline" disabled={rules.length >= 50}
          onClick={() => setRules([...rules, { match: "all", when: [{ field: fields[0]?.id ?? "", op: "eq", value: "" }], destination: events[0] ? { type: "event", eventTypeId: events[0].id } : { type: "message", message: "" } }])}>
          <Plus /> Add rule
        </Button>
      </section>

      <section aria-labelledby="fb-h" className="space-y-3">
        <h2 id="fb-h" className="text-lg font-semibold">Fallback</h2>
        <Card className="p-4">
          <p className="mb-2 text-sm text-muted-foreground">Used when no rule matches.</p>
          <DestinationEditor idPrefix="fb" allowNone dest={fallback} events={events} onChange={setFallback} />
          {err("fallback")}
        </Card>
      </section>

      <div className="sticky bottom-0 -mx-1 flex flex-wrap items-center gap-3 border-t bg-background/95 px-1 py-3 backdrop-blur">
        <Button onClick={save} loading={pending}>Save form</Button>
        <Button asChild variant="outline"><Link href={`/dashboard/routing-forms/${formId}/submissions`}>View submissions</Link></Button>
        {issues.length > 0 && <span className="text-sm text-destructive" role="status">{issues.length} issue{issues.length === 1 ? "" : "s"} to fix: {issues[0]!.message}</span>}
      </div>
    </div>
  );
}
