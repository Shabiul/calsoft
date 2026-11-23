"use client";
import { useState, useTransition } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { DateTime } from "luxon";
import { Badge, Button, Sheet, SheetContent, SheetDescription, SheetTitle, Textarea, toast } from "@/components/ui";
import {
  approveBookingAction, cancelBookingAction, declineBookingAction, markBookingAction, rescheduleBookingAction, rescheduleSlotsAction, saveNotesAction,
} from "@/app/(app)/dashboard/scheduled/actions";

export type DrawerDetail = {
  id: string; status: string; startsAt: string; endsAt: string; eventTitle: string; hostNames: string[]; organizationName: string | null;
  inviteeTimeZone: string; meetingUrl: string | null; notesUrl: string; hostNotes: string | null; cancelReason: string | null; cancelledBy: string | null;
  invitees: { name: string; email: string; phone: string | null }[];
  answers: { question: string; answer: string }[];
  timeline: { id: string; at: string; type: string; actor: string | null; detail: string | null }[];
  canCancel: boolean; canReschedule: boolean; canMark: boolean; rescheduledFromId: string | null;
  canDecide: boolean;
  series: { id: string; count: number; position: number; upcoming: number; pendingApproval: number } | null;
};

const STATUS_VARIANT: Record<string, "success" | "warning" | "destructive" | "secondary" | "default"> = {
  confirmed: "success", pending_payment: "warning", pending_confirmation: "warning", cancelled: "destructive", completed: "default", no_show: "warning", rescheduled: "secondary", expired: "secondary",
};
const fmt = (iso: string, tz: string) => DateTime.fromISO(iso, { zone: tz }).toFormat("ccc, LLL d yyyy · h:mm a");

export function BookingDrawer({ detail, timeZone }: { detail: DrawerDetail; timeZone: string }) {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const [pending, start] = useTransition();
  const [notes, setNotes] = useState(detail.hostNotes ?? "");
  const [mode, setMode] = useState<"view" | "cancel" | "reschedule" | "decline">("view");
  const [cancelScope, setCancelScope] = useState<"occurrence" | "series">("occurrence");
  const [reason, setReason] = useState("");
  const [date, setDate] = useState(DateTime.now().setZone(timeZone).toISODate()!);
  const [slots, setSlots] = useState<string[] | null>(null);

  const close = () => { const n = new URLSearchParams(sp.toString()); n.delete("b"); const s = n.toString(); router.push(s ? `${path}?${s}` : path, { scroll: false }); };
  const open = (id: string) => { const n = new URLSearchParams(sp.toString()); n.set("b", id); router.push(`${path}?${n.toString()}`, { scroll: false }); };
  const done = (msg: string) => { toast.success(msg); setMode("view"); router.refresh(); };

  const loadSlots = (d: string) => start(async () => {
    setDate(d); setSlots(null);
    const r = await rescheduleSlotsAction(detail.id, d, timeZone);
    if (!r.ok) { toast.error(r.error.message); setSlots([]); return; }
    setSlots(r.data.slots);
  });
  const mark = (status: "completed" | "no_show" | "confirmed", msg: string) => start(async () => {
    const r = await markBookingAction(detail.id, status);
    if (!r.ok) toast.error(r.error.message); else done(msg);
  });

  return (
    <Sheet open onOpenChange={(o) => { if (!o) close(); }}>
      <SheetContent className="w-full max-w-md overflow-y-auto sm:max-w-md">
        <div className="space-y-1 pr-6">
          <SheetTitle className="text-lg font-semibold">{detail.eventTitle}</SheetTitle>
          <SheetDescription className="sr-only">Booking details</SheetDescription>
          <div className="flex items-center gap-2">
            <Badge variant={STATUS_VARIANT[detail.status] ?? "secondary"} className="capitalize">{detail.status === "pending_confirmation" ? "Needs approval" : detail.status.replace("_", " ")}</Badge>
            {detail.organizationName && <Badge variant="outline">{detail.organizationName}</Badge>}
          </div>
        </div>

        <dl className="space-y-3 text-sm">
          <Row label="When">{fmt(detail.startsAt, timeZone)} <span className="text-muted-foreground">(your time)</span><br /><span className="text-xs text-muted-foreground">Invitee: {fmt(detail.startsAt, detail.inviteeTimeZone)} ({detail.inviteeTimeZone})</span></Row>
          <Row label={detail.hostNames.length > 1 ? "Hosts" : "Host"}>{detail.hostNames.join(", ")}</Row>
          <Row label={detail.invitees.length > 1 ? "Invitees" : "Invitee"}>
            {detail.invitees.map((i) => <div key={i.email}>{i.name} · <a className="text-brand hover:underline" href={`mailto:${i.email}`}>{i.email}</a>{i.phone ? ` · ${i.phone}` : ""}</div>)}
          </Row>
          {detail.series && <Row label="Series">Session {detail.series.position} of {detail.series.count}{detail.series.pendingApproval > 0 ? ` · ${detail.series.pendingApproval} awaiting approval` : ""}</Row>}
          {detail.notesUrl && <Row label="Meeting notes"><a className="text-brand hover:underline" href={detail.notesUrl} target="_blank" rel="noreferrer">Open shared notes</a></Row>}
          {detail.meetingUrl && <Row label="Location"><a className="break-all text-brand hover:underline" href={detail.meetingUrl} target="_blank" rel="noreferrer">{detail.meetingUrl}</a></Row>}
          {detail.status === "cancelled" && <Row label="Cancelled">{detail.cancelledBy ? `by ${detail.cancelledBy}` : ""}{detail.cancelReason ? ` · ${detail.cancelReason}` : ""}</Row>}
          {detail.rescheduledFromId && <Row label="Rescheduled from"><button className="text-brand hover:underline" onClick={() => open(detail.rescheduledFromId!)}>Previous booking</button></Row>}
        </dl>

        {detail.answers.length > 0 && (
          <section aria-label="Invitee answers" className="space-y-2">
            <h3 className="text-sm font-semibold">Invitee answers</h3>
            {detail.answers.map((a) => <div key={a.question} className="rounded-md bg-muted p-2 text-sm"><div className="text-xs text-muted-foreground">{a.question}</div><div className="whitespace-pre-wrap break-words">{a.answer}</div></div>)}
          </section>
        )}

        <section aria-label="Internal notes" className="space-y-2">
          <h3 className="text-sm font-semibold">Meeting context &amp; internal notes</h3>
          <Textarea value={notes} maxLength={5000} onChange={(e) => setNotes(e.target.value)} placeholder="Visible to your team only, never to the invitee." />
          <Button size="sm" variant="secondary" loading={pending} disabled={notes === (detail.hostNotes ?? "")}
            onClick={() => start(async () => { const r = await saveNotesAction(detail.id, notes); if (!r.ok) toast.error(r.error.message); else done("Notes saved"); })}>Save notes</Button>
        </section>

        {mode === "view" && detail.canDecide && (
          <section className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950/30" aria-label="Approval request">
            <p className="text-sm font-medium">This request is waiting for your approval. The time is held for the invitee until you decide.{detail.series ? ` Approving or declining applies to all ${detail.series.pendingApproval} pending sessions of the series.` : ""}</p>
            <div className="flex gap-2">
              <Button size="sm" loading={pending} onClick={() => start(async () => { const r = await approveBookingAction(detail.id); if (!r.ok) toast.error(r.error.message); else done("Request approved"); })}>Approve</Button>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => setMode("decline")}>Decline</Button>
            </div>
          </section>
        )}
        {mode === "view" && (detail.canCancel || detail.canMark) && (
          <div className="flex flex-wrap gap-2">
            {detail.canReschedule && <Button size="sm" variant="outline" onClick={() => { setMode("reschedule"); loadSlots(date); }}>Reschedule</Button>}
            {detail.canCancel && <Button size="sm" variant="outline" onClick={() => { setCancelScope("occurrence"); setMode("cancel"); }}>{detail.series ? "Cancel this session" : "Cancel"}</Button>}
            {detail.canCancel && detail.series && detail.series.upcoming > 1 && <Button size="sm" variant="outline" onClick={() => { setCancelScope("series"); setMode("cancel"); }}>Cancel entire series ({detail.series.upcoming})</Button>}
            {detail.status === "confirmed" && <Button size="sm" variant="outline" loading={pending} onClick={() => mark("completed", "Marked completed")}>Mark completed</Button>}
            {detail.status === "confirmed" && <Button size="sm" variant="outline" loading={pending} onClick={() => mark("no_show", "Marked no-show")}>No-show</Button>}
            {(detail.status === "completed" || detail.status === "no_show") && <Button size="sm" variant="outline" loading={pending} onClick={() => mark("confirmed", "Reverted to confirmed")}>Undo</Button>}
          </div>
        )}
        {mode === "cancel" && (
          <section className="space-y-2 rounded-md border p-3" aria-label="Cancel booking">
            <p className="text-sm">{cancelScope === "series" ? `Cancel all ${detail.series?.upcoming ?? 0} upcoming sessions of this series? The invitee will be notified.` : "Cancel this booking? The invitee will be notified."}</p>
            <Textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional, shared with the invitee)" />
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" loading={pending} onClick={() => start(async () => { const r = await cancelBookingAction(detail.id, reason, cancelScope); if (!r.ok) toast.error(r.error.message); else done(cancelScope === "series" ? "Series cancelled" : "Booking cancelled"); })}>{cancelScope === "series" ? "Cancel series" : "Cancel booking"}</Button>
              <Button size="sm" variant="ghost" onClick={() => setMode("view")}>Keep it</Button>
            </div>
          </section>
        )}
        {mode === "decline" && (
          <section className="space-y-2 rounded-md border p-3" aria-label="Decline request">
            <p className="text-sm">Decline this request? The time is released and the invitee is notified.</p>
            <Textarea value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional, shared with the invitee)" />
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" loading={pending} onClick={() => start(async () => { const r = await declineBookingAction(detail.id, reason); if (!r.ok) toast.error(r.error.message); else done("Request declined"); })}>Decline request</Button>
              <Button size="sm" variant="ghost" onClick={() => setMode("view")}>Back</Button>
            </div>
          </section>
        )}
        {mode === "reschedule" && (
          <section className="space-y-2 rounded-md border p-3" aria-label="Reschedule booking">
            <label className="block text-sm font-medium" htmlFor="rs-date">New date</label>
            <input id="rs-date" type="date" value={date} min={DateTime.now().setZone(timeZone).toISODate()!} onChange={(e) => e.target.value && loadSlots(e.target.value)} className="h-9 rounded-md border border-input bg-card px-2 text-sm" />
            {slots === null ? <p className="text-sm text-muted-foreground">Loading times...</p> : slots.length === 0 ? <p className="text-sm text-muted-foreground">No open times on this day.</p> : (
              <div className="flex flex-wrap gap-2" role="list">
                {slots.map((s) => (
                  <Button key={s} role="listitem" size="sm" variant="outline" disabled={pending}
                    onClick={() => start(async () => {
                      const r = await rescheduleBookingAction(detail.id, s);
                      if (!r.ok) { toast.error(r.error.message); return; }
                      toast.success("Rescheduled"); setMode("view"); open(r.data.id); router.refresh();
                    })}>{DateTime.fromISO(s, { zone: timeZone }).toFormat("h:mm a")}</Button>
                ))}
              </div>
            )}
            <Button size="sm" variant="ghost" onClick={() => setMode("view")}>Back</Button>
          </section>
        )}

        <section aria-label="History" className="space-y-2">
          <h3 className="text-sm font-semibold">History</h3>
          <ol className="space-y-2 border-l pl-4">
            {detail.timeline.map((t) => (
              <li key={t.id} className="relative text-sm">
                <span className="absolute -left-[1.3rem] top-1.5 size-2 rounded-full bg-brand" aria-hidden />
                <div>{t.type}{t.actor ? <span className="text-muted-foreground"> · {t.actor}</span> : null}</div>
                <div className="text-xs text-muted-foreground">{fmt(t.at, timeZone)}{t.detail ? ` · ${t.detail}` : ""}</div>
              </li>
            ))}
          </ol>
        </section>
      </SheetContent>
    </Sheet>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</dt><dd className="mt-0.5 break-words">{children}</dd></div>;
}
