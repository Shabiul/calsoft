"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarClock, Copy, MoreHorizontal, Plus, Star, Trash2 } from "lucide-react";
import {
  Badge, Button, Card, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownMenu, DropdownMenuContent,
  DropdownMenuItem, DropdownMenuTrigger, EmptyState, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui";
import { unwrap } from "@/components/event-types/action-toast";
import { TimeZonePicker } from "./timezone-picker";
import { formatTime } from "./time-select";
import { WEEKDAYS } from "@/lib/validation/availability";
import {
  createScheduleAction, deleteScheduleAction, duplicateScheduleAction, setDefaultScheduleAction,
} from "@/app/(app)/dashboard/availability/actions";

export type ScheduleListItem = {
  id: string; name: string; timeZone: string; isDefault: boolean; overrideCount: number; eventTypeCount: number;
  rules: { weekday: number; start: string; end: string }[];
};

function summarize(rules: ScheduleListItem["rules"]): string {
  if (!rules.length) return "No weekly hours";
  const parts: string[] = [];
  for (const d of WEEKDAYS) {
    const r = rules.filter((x) => x.weekday === d.value);
    if (r.length) parts.push(`${d.short} ${r.map((x) => `${formatTime(x.start)}–${formatTime(x.end)}`).join(", ")}`);
  }
  return parts.join(" · ");
}

export function ScheduleList({ schedules, defaultTimeZone }: { schedules: ScheduleListItem[]; defaultTimeZone: string }) {
  const router = useRouter();
  const [creating, setCreating] = React.useState(false);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = React.useState<ScheduleListItem | null>(null);

  async function run<T>(key: string, fn: () => Promise<{ ok: true; data: T } | { ok: false; error: { message: string; code: string } }>, msg: string, after?: (d: T) => void) {
    setBusy(key);
    const res = await fn();
    setBusy(null);
    const r = unwrap(res, msg);
    if (r) { after?.(r.data); router.refresh(); }
  }

  return (
    <>
      <div className="mb-4 flex justify-end">
        <Button onClick={() => setCreating(true)}><Plus /> New schedule</Button>
      </div>
      {schedules.length === 0 ? (
        <EmptyState icon={<CalendarClock />} title="No availability schedules yet"
          description="Create a schedule to define the hours people can book you."
          action={<Button onClick={() => setCreating(true)}><Plus /> Create schedule</Button>} />
      ) : (
        <div className="space-y-3">
          {schedules.map((s) => (
            <Card key={s.id} className="flex items-start justify-between gap-3 p-4">
              <Link href={`/dashboard/availability/${s.id}`} className="min-w-0 flex-1 rounded-md focus-visible:outline-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{s.name}</span>
                  {s.isDefault ? <Badge>Default</Badge> : null}
                </div>
                <p className="mt-1 truncate text-sm text-muted-foreground">{summarize(s.rules)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {s.timeZone.replace(/_/g, " ")} · {s.overrideCount} override{s.overrideCount === 1 ? "" : "s"} · used by {s.eventTypeCount} event type{s.eventTypeCount === 1 ? "" : "s"}
                </p>
              </Link>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={`Actions for ${s.name}`} loading={busy === s.id}><MoreHorizontal /></Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {!s.isDefault ? (
                    <DropdownMenuItem onSelect={() => run(s.id, () => setDefaultScheduleAction(s.id), "Default schedule updated")}><Star /> Set as default</DropdownMenuItem>
                  ) : null}
                  <DropdownMenuItem onSelect={() => run(s.id, () => duplicateScheduleAction(s.id), "Schedule duplicated")}><Copy /> Duplicate</DropdownMenuItem>
                  <DropdownMenuItem destructive disabled={schedules.length <= 1} onSelect={() => setConfirmDelete(s)}><Trash2 /> Delete</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </Card>
          ))}
        </div>
      )}

      <CreateDialog open={creating} onOpenChange={setCreating} defaultTimeZone={defaultTimeZone} onCreated={(id) => router.push(`/dashboard/availability/${id}`)} />

      <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete “{confirmDelete?.name}”?</DialogTitle>
            <DialogDescription>
              {confirmDelete && confirmDelete.eventTypeCount > 0
                ? `${confirmDelete.eventTypeCount} event type(s) use this schedule and will fall back to your default schedule. `
                : ""}
              {confirmDelete?.isDefault ? "Another schedule will become your default. " : ""}This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(null)}>Cancel</Button>
            <Button variant="destructive" loading={busy === "delete"} onClick={() => confirmDelete && run("delete", () => deleteScheduleAction(confirmDelete.id), "Schedule deleted", () => setConfirmDelete(null))}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CreateDialog({ open, onOpenChange, defaultTimeZone, onCreated }: { open: boolean; onOpenChange: (o: boolean) => void; defaultTimeZone: string; onCreated: (id: string) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent><CreateForm onOpenChange={onOpenChange} defaultTimeZone={defaultTimeZone} onCreated={onCreated} /></DialogContent>
    </Dialog>
  );
}

function CreateForm({ onOpenChange, defaultTimeZone, onCreated }: { onOpenChange: (o: boolean) => void; defaultTimeZone: string; onCreated: (id: string) => void }) {
  const [name, setName] = React.useState("");
  const [tz, setTz] = React.useState(defaultTimeZone);
  const [template, setTemplate] = React.useState<"weekdays_9_5" | "empty">("weekdays_9_5");
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setErr("Name is required");
    setSaving(true);
    const res = await createScheduleAction({ name, timeZone: tz, template });
    setSaving(false);
    const r = unwrap(res, "Schedule created");
    if (r) { onOpenChange(false); onCreated(r.data.id); } else if (!res.ok) setErr(res.error.message);
  }

  return (
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New availability schedule</DialogTitle>
            <DialogDescription>Use different schedules for different event types, for example “Working hours” and “Office hours”.</DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="new-sched-name">Name</Label>
            <Input id="new-sched-name" value={name} maxLength={80} autoFocus onChange={(e) => { setName(e.target.value); setErr(null); }} placeholder="Working hours" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-sched-tz">Time zone</Label>
            <TimeZonePicker id="new-sched-tz" value={tz} onChange={setTz} />
          </div>
          <div className="space-y-1.5">
            <Label>Start from</Label>
            <Select value={template} onValueChange={(v) => setTemplate(v as typeof template)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="weekdays_9_5">Monday to Friday, 9am to 5pm</SelectItem>
                <SelectItem value="empty">Blank (set hours yourself)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {err ? <p role="alert" className="text-sm text-destructive">{err}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" loading={saving}>Create schedule</Button>
          </DialogFooter>
        </form>
  );
}
