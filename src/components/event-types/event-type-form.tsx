"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui";
import {
  Button, Input, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Switch, Tabs, TabsContent, TabsList, TabsTrigger, Textarea,
} from "@/components/ui";
import { Field, NumberInput, Section } from "./field";
import { HostPicker, type OrgMember } from "./host-picker";
import { QuestionBuilder } from "./question-builder";
import { unwrap } from "./action-toast";
import { createEventTypeAction, updateEventTypeAction } from "@/app/(app)/dashboard/event-types/actions";
import {
  EVENT_KINDS, KIND_HELP, KIND_LABELS, LOCATION_LABELS, LOCATION_TYPES, LOCATIONS_NEEDING_VALUE, eventTypeInputSchema, isTeamKind, slugify,
  type LocationType,
} from "@/lib/validation/event-types";

import type { FormState } from "./event-type-state";
export type { FormState };

const FIELD_TAB: Record<string, string> = {
  title: "details", slug: "details", description: "details", kind: "details", durationMinutes: "details", locationType: "details", locationValue: "details", capacity: "details", color: "details",
  bufferBeforeMinutes: "scheduling", bufferAfterMinutes: "scheduling", minNoticeMinutes: "scheduling", maxHorizonDays: "scheduling", slotIntervalMinutes: "scheduling",
  dailyLimit: "scheduling", weeklyLimit: "scheduling", scheduleId: "scheduling", hosts: "hosts", questions: "questions", pageSettings: "page",
  requiresConfirmation: "advanced", notetakerEnabled: "advanced", cancellationPolicy: "advanced", minCancelNoticeMinutes: "advanced", redirectUrl: "advanced", priceAmount: "advanced",
  priceCurrency: "advanced", paymentProvider: "advanced", reminders: "advanced", recurrence: "advanced",
};
const REMINDER_PRESETS = [{ m: 0, l: "9:00 AM on the day" }, { m: 10, l: "10 minutes" }, { m: 30, l: "30 minutes" }, { m: 60, l: "1 hour" }, { m: 180, l: "3 hours" }, { m: 1440, l: "1 day" }, { m: 2880, l: "2 days" }, { m: 10080, l: "1 week" }];
const CURRENCIES = ["USD", "EUR", "GBP", "INR", "AUD", "CAD", "SGD", "AED", "JPY"];

type Props = {
  mode: "create" | "edit";
  eventTypeId?: string;
  initial: FormState;
  currentUserId: string;
  organizations: { id: string; name: string }[]; // orgs where user can create (admin+)
  membersByOrg: Record<string, OrgMember[]>;
  schedules: { id: string; name: string; isDefault: boolean }[];
};

export function EventTypeForm({ mode, eventTypeId, initial, currentUserId, organizations, membersByOrg, schedules }: Props) {
  const router = useRouter();
  const [v, setV] = React.useState<FormState>(initial);
  const [slugTouched, setSlugTouched] = React.useState(mode === "edit");
  const [errors, setErrors] = React.useState<Record<string, string>>({});
  const [tab, setTab] = React.useState("details");
  const [saving, setSaving] = React.useState(false);

  const set = <K extends keyof FormState>(k: K, val: FormState[K]) => { setV((p) => ({ ...p, [k]: val })); };
  const teamAllowed = !!v.organizationId;
  const members = v.organizationId ? membersByOrg[v.organizationId] ?? [] : [];
  const err = (k: string) => errors[k];

  function toInput() {
    const priceNum = v.priceMajor.trim() === "" ? null : Math.round(Number(v.priceMajor) * 100);
    const clean = (s: string) => (s.trim() === "" ? null : s.trim());
    return {
      organizationId: v.organizationId, title: v.title, slug: v.slug || slugify(v.title), description: clean(v.description), kind: v.kind,
      durationMinutes: v.durationMinutes ?? 0, locationType: v.locationType, locationValue: LOCATIONS_NEEDING_VALUE.includes(v.locationType) ? clean(v.locationValue) : null,
      bufferBeforeMinutes: v.bufferBeforeMinutes ?? 0, bufferAfterMinutes: v.bufferAfterMinutes ?? 0, minNoticeMinutes: v.minNoticeMinutes ?? 0,
      maxHorizonDays: v.maxHorizonDays ?? 60, slotIntervalMinutes: v.slotIntervalMinutes, dailyLimit: v.dailyLimit, weeklyLimit: v.weeklyLimit,
      capacity: v.kind === "group" ? (v.capacity ?? 0) : 1, scheduleId: v.scheduleId, requiresConfirmation: v.requiresConfirmation, notetakerEnabled: v.notetakerEnabled,
      cancellationPolicy: clean(v.cancellationPolicy), allowReschedule: v.allowReschedule, minCancelNoticeMinutes: v.minCancelNoticeMinutes ?? 0,
      color: clean(v.color), redirectUrl: clean(v.redirectUrl),
      priceAmount: priceNum != null && Number.isFinite(priceNum) ? priceNum : null, priceCurrency: clean(v.priceCurrency), paymentProvider: v.paymentProvider,
      reminders: v.reminders, recurrence: v.recurrenceOn ? { count: v.recurrenceCount ?? 0, interval: v.recurrenceInterval } : null,
      isActive: v.isActive, isOneOff: v.isOneOff,
      hosts: v.organizationId ? v.hosts : [],
      questions: v.questions.map((q) => ({ id: q.id, label: q.label, type: q.type, options: q.options.map((o) => o.trim()).filter(Boolean), required: q.required })),
      pageSettings: { brandColor: clean(v.pageBrandColor), logoUrl: clean(v.pageLogoUrl), headline: clean(v.pageHeadline), successMessage: clean(v.pageSuccess) },
    };
  }

  function showIssues(issues: { path: string; message: string }[]) {
    const map: Record<string, string> = {};
    for (const i of issues) {
      const key = i.path.split(".")[0] || "form";
      if (!map[key]) map[key] = i.message;
    }
    setErrors(map);
    const first = Object.keys(map)[0];
    if (first && FIELD_TAB[first]) setTab(FIELD_TAB[first]);
    toast.error(issues[0]?.message ?? "Please fix the highlighted fields");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const input = toInput();
    const parsed = eventTypeInputSchema.safeParse(input);
    if (!parsed.success) return showIssues(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    setErrors({});
    setSaving(true);
    const res = mode === "create" ? await createEventTypeAction(input) : await updateEventTypeAction(eventTypeId!, input);
    setSaving(false);
    if (!res.ok) {
      if (res.error.issues?.length) return showIssues(res.error.issues);
      if (res.error.code === "SLUG_TAKEN") setErrors({ slug: res.error.message });
      return void toast.error(res.error.message);
    }
    unwrap(res, mode === "create" ? "Event type created" : "Changes saved");
    if (mode === "create") router.push(`/dashboard/event-types/${res.data.id}`);
    else router.refresh();
  }

  const onTitle = (title: string) => setV((p) => ({ ...p, title, slug: slugTouched ? p.slug : title.trim() ? slugify(title) : "" }));
  const showTeam = !!v.organizationId;
  const tabHasError = (t: string) => Object.keys(errors).some((k) => FIELD_TAB[k] === t);

  return (
    <form onSubmit={submit} noValidate className="space-y-6">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="flex-wrap h-auto">
          {[["details", "Details"], ["scheduling", "Scheduling"], ...(showTeam ? [["hosts", "Hosts"]] : []), ["questions", "Questions"], ["page", "Booking page"], ["advanced", "Advanced"]].map(([id, label]) => (
            <TabsTrigger key={id} value={id}>{label}{tabHasError(id) ? <span aria-label="has errors" className="ml-1.5 inline-block size-1.5 rounded-full bg-destructive" /> : null}</TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="details" className="space-y-4 pt-4">
          <Section title="Event details">
            {mode === "create" && organizations.length > 0 ? (
              <Field label="Owner" htmlFor="owner">
                <Select value={v.organizationId ?? "personal"} onValueChange={(val) => {
                  const org = val === "personal" ? null : val;
                  setV((p) => ({ ...p, organizationId: org, kind: org ? p.kind : (isTeamKind(p.kind) ? "one_on_one" : p.kind), hosts: org ? [{ userId: currentUserId, priority: 0, weight: 1, isRequired: true }] : [], scheduleId: null }));
                }}>
                  <SelectTrigger id="owner"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="personal">Personal</SelectItem>
                    {organizations.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
            <Field label="Event name" htmlFor="title" error={err("title")}>
              <Input id="title" value={v.title} maxLength={120} placeholder="30 minute meeting" aria-invalid={!!err("title") || undefined} onChange={(e) => onTitle(e.target.value)} />
            </Field>
            <Field label="Link slug" htmlFor="slug" hint="Part of the public URL. Must be unique." error={err("slug")}>
              <Input id="slug" value={v.slug} maxLength={60} aria-invalid={!!err("slug") || undefined} onChange={(e) => { setSlugTouched(true); set("slug", e.target.value.toLowerCase()); }} />
            </Field>
            <Field label="Description" htmlFor="description" error={err("description")}>
              <Textarea id="description" rows={3} value={v.description} onChange={(e) => set("description", e.target.value)} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Duration (minutes)" htmlFor="duration" error={err("durationMinutes")}>
                <NumberInput id="duration" min={5} max={1440} value={v.durationMinutes} onChange={(n) => set("durationMinutes", n)} invalid={!!err("durationMinutes")} />
              </Field>
              <Field label="Colour" htmlFor="color" error={err("color")}>
                <div className="flex items-center gap-2">
                  <input id="color" type="color" aria-label="Event colour" className="h-9 w-12 cursor-pointer rounded-md border border-input bg-card p-1" value={/^#[0-9a-f]{6}$/i.test(v.color) ? v.color : "#6366f1"} onChange={(e) => set("color", e.target.value)} />
                  <span className="text-sm text-muted-foreground">{v.color}</span>
                </div>
              </Field>
            </div>
          </Section>

          <Section title="Event kind" description="How invitees and hosts are matched.">
            <div role="radiogroup" aria-label="Event kind" className="grid gap-2 sm:grid-cols-2">
              {EVENT_KINDS.map((k) => {
                const disabled = isTeamKind(k) && !teamAllowed;
                const on = v.kind === k;
                return (
                  <button key={k} type="button" role="radio" aria-checked={on} disabled={disabled}
                    onClick={() => setV((p) => ({ ...p, kind: k, capacity: k === "group" ? Math.max(p.capacity ?? 2, 2) : 1 }))}
                    className={`cursor-pointer rounded-lg border p-3 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${on ? "border-brand bg-brand/5 ring-1 ring-brand" : "hover:bg-accent"}`}>
                    <span className="block text-sm font-medium">{KIND_LABELS[k]}</span>
                    <span className="block text-xs text-muted-foreground">{disabled ? "Requires an organization" : KIND_HELP[k]}</span>
                  </button>
                );
              })}
            </div>
            {err("kind") ? <p role="alert" className="text-xs text-destructive">{err("kind")}</p> : null}
            {v.kind === "group" ? (
              <Field label="Maximum invitees" htmlFor="capacity" error={err("capacity")}>
                <NumberInput id="capacity" min={2} max={1000} value={v.capacity} onChange={(n) => set("capacity", n)} invalid={!!err("capacity")} />
              </Field>
            ) : null}
          </Section>

          <Section title="Location">
            <Field label="Where does it happen?" htmlFor="loc">
              <Select value={v.locationType} onValueChange={(val) => set("locationType", val as LocationType)}>
                <SelectTrigger id="loc"><SelectValue /></SelectTrigger>
                <SelectContent>{LOCATION_TYPES.map((l) => <SelectItem key={l} value={l}>{LOCATION_LABELS[l]}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            {LOCATIONS_NEEDING_VALUE.includes(v.locationType) ? (
              <Field label={v.locationType === "custom_url" ? "Meeting link" : v.locationType === "in_person" ? "Address" : "Phone number"} htmlFor="locval" error={err("locationValue")}>
                <Input id="locval" value={v.locationValue} aria-invalid={!!err("locationValue") || undefined} onChange={(e) => set("locationValue", e.target.value)} />
              </Field>
            ) : (
              <p className="text-xs text-muted-foreground">The meeting link is generated when the booking is confirmed (requires a connected {LOCATION_LABELS[v.locationType]} account).</p>
            )}
          </Section>
        </TabsContent>

        <TabsContent value="scheduling" className="space-y-4 pt-4">
          <Section title="Availability">
            <Field label="Availability schedule" htmlFor="sched" hint={schedules.length === 0 ? "You have no schedules yet. Create one under Availability." : "Leave on default to follow your default schedule."} error={err("scheduleId")}>
              <Select value={v.scheduleId ?? "default"} onValueChange={(val) => set("scheduleId", val === "default" ? null : val)}>
                <SelectTrigger id="sched"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">Default schedule</SelectItem>
                  {schedules.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}{s.isDefault ? " (default)" : ""}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Minimum notice (minutes)" htmlFor="notice" hint="e.g. 240 = 4 hours" error={err("minNoticeMinutes")}>
                <NumberInput id="notice" min={0} value={v.minNoticeMinutes} onChange={(n) => set("minNoticeMinutes", n)} />
              </Field>
              <Field label="Booking window (days ahead)" htmlFor="horizon" error={err("maxHorizonDays")}>
                <NumberInput id="horizon" min={1} max={730} value={v.maxHorizonDays} onChange={(n) => set("maxHorizonDays", n)} />
              </Field>
              <Field label="Buffer before (minutes)" htmlFor="bbefore" error={err("bufferBeforeMinutes")}>
                <NumberInput id="bbefore" min={0} max={240} value={v.bufferBeforeMinutes} onChange={(n) => set("bufferBeforeMinutes", n)} />
              </Field>
              <Field label="Buffer after (minutes)" htmlFor="bafter" error={err("bufferAfterMinutes")}>
                <NumberInput id="bafter" min={0} max={240} value={v.bufferAfterMinutes} onChange={(n) => set("bufferAfterMinutes", n)} />
              </Field>
              <Field label="Start time increment (minutes)" htmlFor="interval" hint="Blank = same as duration" error={err("slotIntervalMinutes")}>
                <NumberInput id="interval" min={5} max={480} value={v.slotIntervalMinutes} onChange={(n) => set("slotIntervalMinutes", n)} />
              </Field>
            </div>
          </Section>
          <Section title="Booking limits" description="Leave blank for no limit.">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Max bookings per day" htmlFor="daily" error={err("dailyLimit")}>
                <NumberInput id="daily" min={1} value={v.dailyLimit} onChange={(n) => set("dailyLimit", n)} />
              </Field>
              <Field label="Max bookings per week" htmlFor="weekly" error={err("weeklyLimit")}>
                <NumberInput id="weekly" min={1} value={v.weeklyLimit} onChange={(n) => set("weeklyLimit", n)} />
              </Field>
            </div>
          </Section>
        </TabsContent>

        {showTeam ? (
          <TabsContent value="hosts" className="space-y-4 pt-4">
            <Section title="Hosts" description="Choose organization members who host this event.">
              <HostPicker members={members} hosts={v.hosts} kind={v.kind} onChange={(h) => set("hosts", h)} error={err("hosts")} />
            </Section>
          </TabsContent>
        ) : null}

        <TabsContent value="questions" className="space-y-4 pt-4">
          <Section title="Invitee questions">
            <QuestionBuilder questions={v.questions} onChange={(q) => set("questions", q)} error={err("questions")} />
          </Section>
        </TabsContent>

        <TabsContent value="page" className="space-y-4 pt-4">
          <Section title="Booking page" description="Customize what invitees see. Blank fields use your account branding.">
            <Field label="Headline" htmlFor="headline"><Input id="headline" maxLength={160} value={v.pageHeadline} onChange={(e) => set("pageHeadline", e.target.value)} /></Field>
            <Field label="Confirmation message" htmlFor="success" hint="Shown after a booking is made."><Textarea id="success" rows={3} value={v.pageSuccess} onChange={(e) => set("pageSuccess", e.target.value)} /></Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Brand colour (#RRGGBB)" htmlFor="pbrand" error={err("pageSettings")}><Input id="pbrand" placeholder="#6366f1" value={v.pageBrandColor} onChange={(e) => set("pageBrandColor", e.target.value)} /></Field>
              <Field label="Logo URL" htmlFor="plogo"><Input id="plogo" type="url" placeholder="https://…" value={v.pageLogoUrl} onChange={(e) => set("pageLogoUrl", e.target.value)} /></Field>
            </div>
          </Section>
        </TabsContent>

        <TabsContent value="advanced" className="space-y-4 pt-4">
          <Section title="Confirmation and policies">
            <ToggleRow id="confirm" label="Require host confirmation" hint="Bookings stay pending until you approve them." checked={v.requiresConfirmation} onChange={(c) => set("requiresConfirmation", c)} />
            <ToggleRow id="notetaker" label="Notetaker" hint="Optional bot: joins the video call and records audio, video, attendance and chat (needs a Recall.ai API key on the server; without one this switch does nothing). Free alternative: on the meeting's notes page, use Record this meeting or upload a recording and Gemini writes the transcript, summary and action items." checked={v.notetakerEnabled} onChange={(c) => set("notetakerEnabled", c)} />
            <ToggleRow id="resched" label="Allow invitees to reschedule" checked={v.allowReschedule} onChange={(c) => set("allowReschedule", c)} />
            <Field label="Minimum notice to cancel/reschedule (minutes)" htmlFor="cnotice" error={err("minCancelNoticeMinutes")}>
              <NumberInput id="cnotice" min={0} value={v.minCancelNoticeMinutes} onChange={(n) => set("minCancelNoticeMinutes", n)} />
            </Field>
            <Field label="Cancellation policy" htmlFor="policy" error={err("cancellationPolicy")}><Textarea id="policy" rows={2} value={v.cancellationPolicy} onChange={(e) => set("cancellationPolicy", e.target.value)} /></Field>
            <Field label="Redirect after booking (URL)" htmlFor="redirect" hint="Send invitees to your own page instead of the confirmation screen." error={err("redirectUrl")}>
              <Input id="redirect" type="url" placeholder="https://example.com/thanks" value={v.redirectUrl} onChange={(e) => set("redirectUrl", e.target.value)} />
            </Field>
          </Section>
          <Section title="Reminders" description="Email reminders sent before the meeting.">
            <div className="flex flex-wrap gap-2">
              {REMINDER_PRESETS.map((p) => {
                const on = v.reminders.includes(p.m);
                return (
                  <button key={p.m} type="button" aria-pressed={on} onClick={() => set("reminders", on ? v.reminders.filter((x) => x !== p.m) : [...v.reminders, p.m].sort((a, b) => b - a))}
                    className={`cursor-pointer rounded-full border px-3 py-1 text-sm ${on ? "border-brand bg-brand/10 text-brand" : "hover:bg-accent"}`}>{p.l}{p.m ? " before" : ""}</button>
                );
              })}
            </div>
            {err("reminders") ? <p role="alert" className="text-xs text-destructive">{err("reminders")}</p> : null}
          </Section>
          <Section title="Recurring meetings">
            <ToggleRow id="recur" label="Book a series" hint="Invitees book repeating sessions in one go." checked={v.recurrenceOn} onChange={(c) => set("recurrenceOn", c)} />
            {v.recurrenceOn ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Number of sessions" htmlFor="rcount" error={err("recurrence")}><NumberInput id="rcount" min={2} max={52} value={v.recurrenceCount} onChange={(n) => set("recurrenceCount", n)} /></Field>
                <Field label="Repeats every" htmlFor="rint">
                  <Select value={v.recurrenceInterval} onValueChange={(val) => set("recurrenceInterval", val as "week" | "month")}>
                    <SelectTrigger id="rint"><SelectValue /></SelectTrigger>
                    <SelectContent><SelectItem value="week">Week</SelectItem><SelectItem value="month">Month</SelectItem></SelectContent>
                  </Select>
                </Field>
              </div>
            ) : null}
          </Section>
          <Section title="Payment" description="Charge invitees at booking time. Leave the price blank for free events.">
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Price" htmlFor="price" error={err("priceAmount")}>
                <Input id="price" inputMode="decimal" placeholder="0.00" value={v.priceMajor} onChange={(e) => set("priceMajor", e.target.value.replace(/[^0-9.]/g, ""))} />
              </Field>
              <Field label="Currency" htmlFor="cur" error={err("priceCurrency")}>
                <Select value={v.priceCurrency} onValueChange={(val) => set("priceCurrency", val)}>
                  <SelectTrigger id="cur"><SelectValue /></SelectTrigger>
                  <SelectContent>{CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
                </Select>
              </Field>
              <Field label="Provider" htmlFor="prov" error={err("paymentProvider")}>
                <Select value={v.paymentProvider ?? "none"} onValueChange={(val) => set("paymentProvider", val === "none" ? null : (val as "stripe" | "razorpay"))}>
                  <SelectTrigger id="prov"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="none">Choose…</SelectItem><SelectItem value="stripe">Stripe</SelectItem><SelectItem value="razorpay">Razorpay</SelectItem></SelectContent>
                </Select>
              </Field>
            </div>
          </Section>
          <Section title="Status">
            <ToggleRow id="active" label="Event is active" hint="Inactive events cannot be booked." checked={v.isActive} onChange={(c) => set("isActive", c)} />
          </Section>
        </TabsContent>
      </Tabs>

      <div className="sticky bottom-0 -mx-1 flex items-center justify-end gap-2 border-t bg-background/90 px-1 py-3 backdrop-blur">
        <Button asChild variant="outline"><Link href="/dashboard/event-types">Cancel</Link></Button>
        <Button type="submit" loading={saving}>{mode === "create" ? "Create event type" : "Save changes"}</Button>
      </div>
    </form>
  );
}

function ToggleRow({ id, label, hint, checked, onChange }: { id: string; label: string; hint?: string; checked: boolean; onChange: (c: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <label htmlFor={id} className="cursor-pointer"><span className="block text-sm font-medium">{label}</span>{hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}</label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

