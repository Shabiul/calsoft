"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button, Card, Input, Label, Textarea } from "@/components/ui";
import { createWorkflowAction, updateWorkflowAction } from "./actions";
import { ACTION_LABELS, TEMPLATE_VARIABLES, TRIGGER_LABELS } from "./labels";

import { blankStep, type StepState, type WorkflowFormValue } from "./workflow-state";
import { samplesForTrigger } from "@/lib/workflow-samples";
export type { StepState, WorkflowFormValue };

const selectCls = "flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm shadow-sm";

/** Offset UI: direction + minutes, stored as a single signed number. */
function OffsetField({ trigger, value, onChange }: { trigger: string; value: number; onChange: (n: number) => void }) {
  const before = value < 0;
  const canBefore = trigger !== "booking_completed" && trigger !== "booking_cancelled";
  return (
    <div className="flex items-center gap-2">
      <Input type="number" min={0} className="w-24" aria-label="Offset minutes" value={Math.abs(value)}
        onChange={(e) => { const n = Math.max(0, Math.floor(Number(e.target.value) || 0)); onChange(before ? -n : n); }} />
      <select className={selectCls + " w-auto"} aria-label="Offset direction" value={before && canBefore ? "before" : "after"}
        onChange={(e) => onChange(e.target.value === "before" ? -Math.abs(value) : Math.abs(value))}>
        <option value="after">minutes after trigger</option>
        {canBefore && <option value="before">minutes before meeting starts</option>}
      </select>
    </div>
  );
}

export function WorkflowForm({ initial, eventTypes }: { initial: WorkflowFormValue; eventTypes: { id: string; title: string }[] }) {
  const router = useRouter();
  const [v, setV] = useState<WorkflowFormValue>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();
  const setStep = (i: number, patch: Partial<StepState>) => setV((s) => ({ ...s, steps: s.steps.map((st, j) => (j === i ? { ...st, ...patch } : st)) }));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setErrors({});
    const payload = {
      name: v.name, trigger: v.trigger, isActive: v.isActive, eventTypeIds: v.eventTypeIds.length ? v.eventTypeIds : null,
      steps: v.steps.map((s) => s.action === "send_email"
        ? { action: s.action, offsetMinutes: s.offsetMinutes, to: s.to, subject: s.subject, body: s.body, attachIcs: s.attachIcs }
        : { action: s.action, offsetMinutes: s.offsetMinutes, url: s.url, ...(s.secret ? { secret: s.secret } : s.secretEnc ? { secretEnc: s.secretEnc } : {}) }),
    };
    start(async () => {
      const res = v.id ? await updateWorkflowAction(v.id, payload) : await createWorkflowAction(payload);
      if (!res.ok) {
        const map: Record<string, string> = {};
        for (const i of res.error.issues ?? []) map[i.path] = i.message;
        setErrors(map);
        toast.error(res.error.message);
        return;
      }
      toast.success(v.id ? "Workflow saved" : "Workflow created");
      router.push("/dashboard/workflows");
      router.refresh();
    });
  };

  return (
    <form onSubmit={submit} className="space-y-6">
      <Card className="space-y-4 p-5">
        <div className="space-y-1.5">
          <Label htmlFor="wf-name">Name</Label>
          <Input id="wf-name" value={v.name} maxLength={120} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="e.g. Post-meeting follow up" aria-invalid={!!errors.name} />
          {errors.name && <p className="text-sm text-destructive">{errors.name}</p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="wf-trigger">Trigger</Label>
          <select id="wf-trigger" className={selectCls} value={v.trigger} onChange={(e) => setV({ ...v, trigger: e.target.value })}>
            {Object.entries(TRIGGER_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Event types</legend>
          <p className="text-xs text-muted-foreground">Leave all unchecked to apply to every event type.</p>
          {eventTypes.length === 0 ? <p className="text-sm text-muted-foreground">You have no event types yet.</p> : (
            <div className="grid gap-2 sm:grid-cols-2">
              {eventTypes.map((et) => (
                <label key={et.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={v.eventTypeIds.includes(et.id)}
                    onChange={(e) => setV({ ...v, eventTypeIds: e.target.checked ? [...v.eventTypeIds, et.id] : v.eventTypeIds.filter((x) => x !== et.id) })} />
                  {et.title}
                </label>
              ))}
            </div>
          )}
        </fieldset>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={v.isActive} onChange={(e) => setV({ ...v, isActive: e.target.checked })} /> Active
        </label>
      </Card>

      <div className="space-y-3">
        <h2 className="text-base font-semibold">Steps</h2>
        {errors.steps && <p className="text-sm text-destructive">{errors.steps}</p>}
        {v.steps.map((s, i) => (
          <Card key={i} className="space-y-4 p-5">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Step {i + 1}</span>
              {v.steps.length > 1 && (
                <Button type="button" variant="ghost" size="sm" onClick={() => setV({ ...v, steps: v.steps.filter((_, j) => j !== i) })}><Trash2 /> Remove</Button>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor={`a-${i}`}>Action</Label>
                <select id={`a-${i}`} className={selectCls} value={s.action} onChange={(e) => setStep(i, { action: e.target.value as StepState["action"] })}>
                  {Object.entries(ACTION_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>When</Label>
                <OffsetField trigger={v.trigger} value={s.offsetMinutes} onChange={(n) => setStep(i, { offsetMinutes: n })} />
                {errors[`steps.${i}.offsetMinutes`] && <p className="text-sm text-destructive">{errors[`steps.${i}.offsetMinutes`]}</p>}
              </div>
            </div>
            {s.action === "send_email" ? (
              <>
                {samplesForTrigger(v.trigger).length > 0 && (
                  <div className="space-y-1.5">
                    <Label htmlFor={`sample-${i}`}>Start from a sample message</Label>
                    <select id={`sample-${i}`} className={selectCls} value="" onChange={(e) => {
                      const sample = samplesForTrigger(v.trigger).find((x) => x.id === e.target.value);
                      if (sample) setStep(i, { subject: sample.subject, body: sample.body, offsetMinutes: sample.offsetMinutes, to: sample.to, attachIcs: sample.attachIcs });
                    }}>
                      <option value="">Choose a sample to fill the subject, message, timing and attachment...</option>
                      {samplesForTrigger(v.trigger).map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                    </select>
                    <p className="text-xs text-muted-foreground">Replaces this step&apos;s subject and message. You can edit everything afterwards.</p>
                  </div>
                )}
                <div className="space-y-1.5">
                  <Label htmlFor={`to-${i}`}>Send to</Label>
                  <select id={`to-${i}`} className={selectCls} value={s.to} onChange={(e) => setStep(i, { to: e.target.value as StepState["to"] })}>
                    <option value="invitee">Invitee</option><option value="host">Host (me)</option><option value="both">Both</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`sub-${i}`}>Subject</Label>
                  <Input id={`sub-${i}`} value={s.subject} maxLength={200} onChange={(e) => setStep(i, { subject: e.target.value })} aria-invalid={!!errors[`steps.${i}.subject`]} />
                  {errors[`steps.${i}.subject`] && <p className="text-sm text-destructive">{errors[`steps.${i}.subject`]}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`body-${i}`}>Message</Label>
                  <Textarea id={`body-${i}`} rows={6} value={s.body} maxLength={5000} onChange={(e) => setStep(i, { body: e.target.value })} aria-invalid={!!errors[`steps.${i}.body`]} />
                  {errors[`steps.${i}.body`] && <p className="text-sm text-destructive">{errors[`steps.${i}.body`]}</p>}
                  <p className="text-xs text-muted-foreground">Variables: {TEMPLATE_VARIABLES.map((t) => `{{${t}}}`).join(" ")}. Plain text only; content is HTML-escaped.</p>
                </div>
                <label className="flex items-start gap-2 text-sm" htmlFor={`ics-${i}`}>
                  <input id={`ics-${i}`} type="checkbox" className="mt-1" checked={s.attachIcs} onChange={(e) => setStep(i, { attachIcs: e.target.checked })} />
                  <span>
                    <span className="font-medium">Attach the calendar invite (.ics)</span>
                    <span className="block text-xs text-muted-foreground">
                      The invitee can add the meeting to Google, Outlook or Apple Calendar in one click. For cancelled bookings the attachment removes the event from their calendar. Sent to the invitee only.
                    </span>
                  </span>
                </label>
              </>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor={`url-${i}`}>Webhook URL</Label>
                  <Input id={`url-${i}`} type="url" value={s.url} placeholder="https://example.com/hooks/meetflow" onChange={(e) => setStep(i, { url: e.target.value })} aria-invalid={!!errors[`steps.${i}.url`]} />
                  {errors[`steps.${i}.url`] && <p className="text-sm text-destructive">{errors[`steps.${i}.url`]}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`sec-${i}`}>Signing secret (optional)</Label>
                  <Input id={`sec-${i}`} type="password" autoComplete="off" value={s.secret} placeholder={s.hasSecret ? "Leave blank to keep the current secret" : "Used to sign the request (HMAC-SHA256)"} onChange={(e) => setStep(i, { secret: e.target.value })} />
                </div>
              </>
            )}
          </Card>
        ))}
        {v.steps.length < 10 && (
          <Button type="button" variant="outline" onClick={() => setV({ ...v, steps: [...v.steps, blankStep()] })}><Plus /> Add step</Button>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" loading={pending}>{v.id ? "Save changes" : "Create workflow"}</Button>
        <Button asChild variant="ghost"><Link href="/dashboard/workflows">Cancel</Link></Button>
      </div>
    </form>
  );
}
