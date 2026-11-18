"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { CalendarOff, Copy, Plus, Trash2 } from "lucide-react";
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader,
  DialogTitle, Input, Label, Popover, PopoverContent, PopoverTrigger, Switch, Checkbox,
} from "@/components/ui";
import { unwrap } from "@/components/event-types/action-toast";
import { TimeZonePicker } from "./timezone-picker";
import { TimeSelect, formatTime } from "./time-select";
import { saveScheduleAction } from "@/app/(app)/dashboard/availability/actions";
import { WEEKDAYS, findIntervalProblem, scheduleInputSchema, type Interval, type OverrideInput } from "@/lib/validation/availability";

type Props = {
  schedule: {
    id: string; name: string; timeZone: string; isDefault: boolean;
    rules: { weekday: number; start: string; end: string }[]; overrides: OverrideInput[];
  };
};

type Week = Interval[][]; // index = weekday

const toWeek = (rules: Props["schedule"]["rules"]): Week =>
  WEEKDAYS.map((d) => rules.filter((r) => r.weekday === d.value).map((r) => ({ start: r.start, end: r.end })));

function nextInterval(list: Interval[]): Interval {
  const last = list[list.length - 1];
  if (!last) return { start: "09:00", end: "17:00" };
  const [h] = last.end.split(":").map(Number);
  const s = Math.min(h + 1, 22);
  return { start: `${String(s).padStart(2, "0")}:00`, end: `${String(Math.min(s + 1, 23)).padStart(2, "0")}:00` };
}

export function ScheduleEditor({ schedule }: Props) {
  const router = useRouter();
  const [name, setName] = React.useState(schedule.name);
  const [tz, setTz] = React.useState(schedule.timeZone);
  const [week, setWeek] = React.useState<Week>(() => toWeek(schedule.rules));
  const [overrides, setOverrides] = React.useState<OverrideInput[]>(schedule.overrides);
  const [saving, setSaving] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const touch = () => { setDirty(true); setError(null); };
  const setDay = (d: number, next: Interval[]) => { setWeek((w) => w.map((x, i) => (i === d ? next : x))); touch(); };
  const problems = week.map((list) => findIntervalProblem(list));

  const copyTo = (from: number, targets: number[]) => {
    setWeek((w) => w.map((x, i) => (targets.includes(i) ? w[from].map((iv) => ({ ...iv })) : x)));
    touch();
  };

  async function save() {
    const payload = {
      name, timeZone: tz,
      rules: week.flatMap((list, weekday) => list.map((iv) => ({ weekday, start: iv.start, end: iv.end }))),
      overrides,
    };
    const parsed = scheduleInputSchema.safeParse(payload);
    if (!parsed.success) { setError(parsed.error.issues[0].message); return; }
    setSaving(true);
    const res = await saveScheduleAction(schedule.id, parsed.data);
    setSaving(false);
    if (unwrap(res, "Schedule saved")) { setDirty(false); router.refresh(); }
    else if (!res.ok) setError(res.error.message);
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>Schedule details</CardTitle>
            {schedule.isDefault ? <Badge>Default</Badge> : null}
          </div>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="sched-name">Name</Label>
            <Input id="sched-name" value={name} maxLength={80} onChange={(e) => { setName(e.target.value); touch(); }} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sched-tz">Time zone</Label>
            <TimeZonePicker id="sched-tz" value={tz} onChange={(v) => { setTz(v); touch(); }} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Weekly hours</CardTitle>
          <CardDescription>Set when you are regularly available. Add several intervals per day for breaks.</CardDescription>
        </CardHeader>
        <CardContent className="divide-y">
          {WEEKDAYS.map((d) => {
            const list = week[d.value];
            const on = list.length > 0;
            return (
              <div key={d.value} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start">
                <div className="flex w-36 shrink-0 items-center gap-3 pt-1.5">
                  <Switch checked={on} aria-label={`${d.label} available`} onCheckedChange={(c) => setDay(d.value, c ? [nextInterval([])] : [])} />
                  <span className="text-sm font-medium">{d.label}</span>
                </div>
                <div className="flex-1 space-y-2">
                  {!on ? <p className="pt-1.5 text-sm text-muted-foreground">Unavailable</p> : null}
                  {list.map((iv, idx) => (
                    <div key={idx} className="flex flex-wrap items-center gap-2">
                      <TimeSelect label={`${d.label} start`} value={iv.start} invalid={!!problems[d.value]}
                        onChange={(v) => setDay(d.value, list.map((x, i) => (i === idx ? { ...x, start: v } : x)))} />
                      <span className="text-muted-foreground">–</span>
                      <TimeSelect label={`${d.label} end`} value={iv.end} invalid={!!problems[d.value]}
                        onChange={(v) => setDay(d.value, list.map((x, i) => (i === idx ? { ...x, end: v } : x)))} />
                      <Button type="button" variant="ghost" size="icon" aria-label="Remove interval" onClick={() => setDay(d.value, list.filter((_, i) => i !== idx))}>
                        <Trash2 />
                      </Button>
                    </div>
                  ))}
                  {problems[d.value] ? <p role="alert" className="text-xs text-destructive">{problems[d.value]}</p> : null}
                </div>
                <div className="flex gap-1">
                  <Button type="button" variant="ghost" size="icon" aria-label={`Add interval on ${d.label}`} disabled={list.length >= 12}
                    onClick={() => setDay(d.value, [...list, nextInterval(list)])}>
                    <Plus />
                  </Button>
                  <CopyTimesPopover from={d.value} disabled={!on} onCopy={copyTo} />
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      <OverridesCard overrides={overrides} onChange={(o) => { setOverrides(o); touch(); }} />

      {error ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p> : null}
      <div className="sticky bottom-0 -mx-1 flex items-center justify-end gap-2 border-t bg-background/90 px-1 py-3 backdrop-blur">
        {dirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
        <Button type="button" variant="outline" onClick={() => router.push("/dashboard/availability")}>Back</Button>
        <Button type="button" onClick={save} loading={saving} disabled={!dirty && !saving}>Save schedule</Button>
      </div>
    </div>
  );
}

function CopyTimesPopover({ from, disabled, onCopy }: { from: number; disabled?: boolean; onCopy: (from: number, targets: number[]) => void }) {
  const [open, setOpen] = React.useState(false);
  const [sel, setSel] = React.useState<number[]>([]);
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setSel([]); }}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label={`Copy ${WEEKDAYS[from].label} times to other days`} disabled={disabled}><Copy /></Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56">
        <p className="mb-2 text-sm font-medium">Copy times to</p>
        <div className="space-y-2">
          {WEEKDAYS.filter((d) => d.value !== from).map((d) => (
            <label key={d.value} className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox checked={sel.includes(d.value)} onCheckedChange={(c) => setSel((s) => (c ? [...s, d.value] : s.filter((x) => x !== d.value)))} />
              {d.label}
            </label>
          ))}
        </div>
        <Button type="button" size="sm" className="mt-3 w-full" disabled={sel.length === 0} onClick={() => { onCopy(from, sel); setOpen(false); }}>Apply</Button>
      </PopoverContent>
    </Popover>
  );
}

function OverridesCard({ overrides, onChange }: { overrides: OverrideInput[]; onChange: (o: OverrideInput[]) => void }) {
  const [open, setOpen] = React.useState(false);
  const sorted = [...overrides].sort((a, b) => a.date.localeCompare(b.date));
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle>Date overrides</CardTitle>
            <CardDescription>Change your hours for a specific date, or mark it unavailable.</CardDescription>
          </div>
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}><Plus /> Add override</Button>
        </div>
      </CardHeader>
      <CardContent>
        {sorted.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><CalendarOff className="size-4" /> No date overrides. Your weekly hours apply every week.</p>
        ) : (
          <ul className="divide-y">
            {sorted.map((o) => (
              <li key={o.date} className="flex items-center justify-between gap-3 py-2">
                <div>
                  <p className="text-sm font-medium">{new Date(`${o.date}T00:00:00`).toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric" })}</p>
                  <p className="text-xs text-muted-foreground">{o.unavailable ? "Unavailable" : o.intervals.map((i) => `${formatTime(i.start)} – ${formatTime(i.end)}`).join(", ")}</p>
                </div>
                <Button type="button" variant="ghost" size="icon" aria-label={`Remove override for ${o.date}`} onClick={() => onChange(overrides.filter((x) => x.date !== o.date))}><Trash2 /></Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
      <OverrideDialog open={open} onOpenChange={setOpen} existing={overrides.map((o) => o.date)} onAdd={(o) => onChange([...overrides, o])} />
    </Card>
  );
}

function OverrideDialog({ open, onOpenChange, existing, onAdd }: { open: boolean; onOpenChange: (o: boolean) => void; existing: string[]; onAdd: (o: OverrideInput) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent><OverrideForm onOpenChange={onOpenChange} existing={existing} onAdd={onAdd} /></DialogContent>
    </Dialog>
  );
}

function OverrideForm({ onOpenChange, existing, onAdd }: { onOpenChange: (o: boolean) => void; existing: string[]; onAdd: (o: OverrideInput) => void }) {
  const [date, setDate] = React.useState("");
  const [off, setOff] = React.useState(true);
  const [ivs, setIvs] = React.useState<Interval[]>([{ start: "09:00", end: "17:00" }]);
  const [err, setErr] = React.useState<string | null>(null);

  const submit = () => {
    if (!date) return setErr("Choose a date");
    if (existing.includes(date)) return setErr("There is already an override for this date");
    if (!off) {
      const p = findIntervalProblem(ivs);
      if (p) return setErr(p);
    }
    onAdd({ date, unavailable: off, intervals: off ? [] : ivs });
    onOpenChange(false);
  };

  return (
      <>
        <DialogHeader>
          <DialogTitle>Add date override</DialogTitle>
          <DialogDescription>Overrides replace your weekly hours for that date. Save the schedule to apply.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="ovr-date">Date</Label>
            <Input id="ovr-date" type="date" value={date} onChange={(e) => { setDate(e.target.value); setErr(null); }} />
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Switch checked={off} onCheckedChange={setOff} aria-label="Unavailable all day" /> Unavailable all day
          </label>
          {!off ? (
            <div className="space-y-2">
              {ivs.map((iv, i) => (
                <div key={i} className="flex items-center gap-2">
                  <TimeSelect label="Override start" value={iv.start} onChange={(v) => setIvs(ivs.map((x, k) => (k === i ? { ...x, start: v } : x)))} />
                  <span className="text-muted-foreground">–</span>
                  <TimeSelect label="Override end" value={iv.end} onChange={(v) => setIvs(ivs.map((x, k) => (k === i ? { ...x, end: v } : x)))} />
                  <Button type="button" variant="ghost" size="icon" aria-label="Remove interval" disabled={ivs.length === 1} onClick={() => setIvs(ivs.filter((_, k) => k !== i))}><Trash2 /></Button>
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" onClick={() => setIvs([...ivs, nextInterval(ivs)])}><Plus /> Add interval</Button>
            </div>
          ) : null}
          {err ? <p role="alert" className="text-sm text-destructive">{err}</p> : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button type="button" onClick={submit}>Add override</Button>
        </DialogFooter>
      </>
  );
}
