"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Palmtree, Trash2 } from "lucide-react";
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from "@/components/ui";
import { unwrap } from "@/components/event-types/action-toast";
import { createBlockedTimeAction, deleteBlockedTimeAction } from "@/app/(app)/dashboard/availability/actions";

export type BlockedItem = { id: string; startsAt: string; endsAt: string; reason: string | null };

const fmt = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

export function BlockedTimes({ items }: { items: BlockedItem[] }) {
  const router = useRouter();
  const [start, setStart] = React.useState("");
  const [end, setEnd] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState<string | null>(null);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!start || !end) return setErr("Choose a start and end");
    const s = new Date(start), en = new Date(end);
    if (!(s < en)) return setErr("End must be after start");
    setSaving(true);
    const res = await createBlockedTimeAction({ startsAt: s.toISOString(), endsAt: en.toISOString(), reason: reason || undefined });
    setSaving(false);
    if (unwrap(res, "Time blocked")) { setStart(""); setEnd(""); setReason(""); setErr(null); router.refresh(); }
    else if (!res.ok) setErr(res.error.message);
  }
  async function remove(id: string) {
    setRemoving(id);
    const res = await deleteBlockedTimeAction(id);
    setRemoving(null);
    if (unwrap(res, "Block removed")) router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Time off and blocked periods</CardTitle>
        <CardDescription>Block out vacations or one-off absences across all your schedules. Times use your browser time zone.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={add} className="grid gap-3 sm:grid-cols-[1fr_1fr_1.2fr_auto] sm:items-end">
          <div className="space-y-1.5"><Label htmlFor="blk-start">From</Label><Input id="blk-start" type="datetime-local" value={start} onChange={(e) => { setStart(e.target.value); setErr(null); }} /></div>
          <div className="space-y-1.5"><Label htmlFor="blk-end">Until</Label><Input id="blk-end" type="datetime-local" value={end} onChange={(e) => { setEnd(e.target.value); setErr(null); }} /></div>
          <div className="space-y-1.5"><Label htmlFor="blk-reason">Reason (optional)</Label><Input id="blk-reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} placeholder="Vacation" /></div>
          <Button type="submit" loading={saving}>Block time</Button>
        </form>
        {err ? <p role="alert" className="text-sm text-destructive">{err}</p> : null}
        {items.length === 0 ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Palmtree className="size-4" /> No upcoming blocked periods.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {items.map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{fmt(b.startsAt)} – {fmt(b.endsAt)}</p>
                  {b.reason ? <p className="truncate text-xs text-muted-foreground">{b.reason}</p> : null}
                </div>
                <Button type="button" variant="ghost" size="icon" aria-label="Remove blocked period" loading={removing === b.id} onClick={() => remove(b.id)}><Trash2 /></Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
