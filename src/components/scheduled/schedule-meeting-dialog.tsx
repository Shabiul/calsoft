"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DateTime } from "luxon";
import { CalendarPlus, Check, Loader2, Plus, X } from "lucide-react";
import { toast } from "sonner";
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger, Input, Label, Textarea } from "@/components/ui";
import { getMeetingUrlAction, getScheduleSlotsAction, scheduleMeetingAction } from "@/app/(app)/dashboard/scheduled/actions";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const sel = "h-9 w-full rounded-md border border-input bg-card px-2 text-sm";

export function ScheduleMeetingDialog({ events, timeZone }: { events: { id: string; title: string }[]; timeZone: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [eventId, setEventId] = useState(events[0]?.id ?? "");
  const [date, setDate] = useState(DateTime.now().setZone(timeZone).toISODate()!);
  const [slots, setSlots] = useState<string[] | null>(null);
  const [slot, setSlot] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [guests, setGuests] = useState<string[]>([]);
  const [context, setContext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState<string | null>(null); // booking id while the Meet link is being created

  useEffect(() => {
    if (!open || !eventId || !date) return;
    let live = true;
    setSlots(null); setSlot("");
    const from = DateTime.fromISO(date, { zone: timeZone }).startOf("day");
    getScheduleSlotsAction(eventId, from.toUTC().toISO()!, from.plus({ days: 1 }).toUTC().toISO()!, timeZone).then((r) => {
      if (!live) return;
      if (r.ok) setSlots(r.data); else { setSlots([]); setError(r.error.message); }
    });
    return () => { live = false; };
  }, [open, eventId, date, timeZone]);

  useEffect(() => {
    if (!preparing) return;
    let live = true;
    const started = Date.now();
    (async () => {
      let url: string | null = null;
      while (live && Date.now() - started < 60_000) {
        const r = await getMeetingUrlAction(preparing);
        if (r.ok && r.data.meetingUrl) { url = r.data.meetingUrl; break; }
        await new Promise((res) => setTimeout(res, 2000));
      }
      if (!live) return;
      setPreparing(null); setOpen(false);
      toast.success(url ? "Meeting scheduled with a Google Meet link. Invitations sent." : "Meeting scheduled. The Meet link will arrive by email shortly.");
      router.refresh();
    })();
    return () => { live = false; };
  }, [preparing, router]);

  const submit = () => {
    setError(null);
    if (!eventId) return setError("Choose an event type");
    if (!slot) return setError("Choose a time");
    if (!name.trim()) return setError("Enter the invitee's name");
    if (!EMAIL.test(email.trim())) return setError("Enter a valid invitee email");
    const g = guests.map((x) => x.trim()).filter(Boolean);
    if (g.some((x) => !EMAIL.test(x))) return setError("One of the attendee emails is invalid");
    start(async () => {
      const r = await scheduleMeetingAction({ eventTypeId: eventId, startsAt: slot, timeZone, invitee: { name: name.trim(), email: email.trim() }, guests: g, context: context.trim() || undefined });
      if (!r.ok) return setError(r.error.message);
      setName(""); setEmail(""); setGuests([]); setSlot(""); setContext("");
      if (r.data.meetPending) { setPreparing(r.data.bookingId); return; }
      toast.success("Meeting scheduled. Invitations sent.");
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!preparing) setOpen(o); }}>
      <DialogTrigger asChild><Button disabled={events.length === 0}><CalendarPlus /> Schedule meeting</Button></DialogTrigger>
      <DialogContent>
        {preparing ? (
          <div role="status" aria-live="polite" className="grid gap-4 py-6 text-center">
            <Loader2 className="mx-auto size-10 animate-spin text-brand" aria-hidden />
            <div><DialogTitle>Setting up the meeting</DialogTitle>
              <DialogDescription>Please keep this open. This usually takes a few seconds.</DialogDescription></div>
            <ul className="mx-auto grid gap-2 text-left text-sm">
              <li className="flex items-center gap-2"><Check className="size-4 text-success" aria-hidden /> Time reserved</li>
              <li className="flex items-center gap-2"><Loader2 className="size-4 animate-spin text-brand" aria-hidden /> Creating the Google Meet link</li>
              <li className="flex items-center gap-2 opacity-50"><span className="size-4 rounded-full border-2" aria-hidden /> Sending invitations to everyone</li>
            </ul>
          </div>
        ) : (<>
        <DialogHeader>
          <DialogTitle>Schedule a meeting</DialogTitle>
          <DialogDescription>Book a time for someone and invite other attendees. Everyone gets an email and a calendar invite (with a Meet link if the event uses Google Meet).</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5"><Label htmlFor="sm-event">Event type</Label>
            <select id="sm-event" className={sel} value={eventId} onChange={(e) => setEventId(e.target.value)}>
              {events.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
            </select></div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5"><Label htmlFor="sm-date">Date</Label>
              <Input id="sm-date" type="date" min={DateTime.now().setZone(timeZone).toISODate()!} value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div className="grid gap-1.5"><Label htmlFor="sm-time">Time ({timeZone})</Label>
              <select id="sm-time" className={sel} value={slot} onChange={(e) => setSlot(e.target.value)} disabled={!slots?.length}>
                <option value="">{slots === null ? "Loading..." : slots.length ? "Select a time" : "No times available"}</option>
                {slots?.map((s) => <option key={s} value={s}>{DateTime.fromISO(s).setZone(timeZone).toFormat("h:mm a")}</option>)}
              </select></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5"><Label htmlFor="sm-name">Invitee name</Label>
              <Input id="sm-name" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="grid gap-1.5"><Label htmlFor="sm-email">Invitee email</Label>
              <Input id="sm-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
          </div>
          <div className="grid gap-2">
            <Label>Invite attendees (optional)</Label>
            {guests.map((g, i) => (
              <div key={i} className="flex gap-2">
                <Input type="email" placeholder="attendee@example.com" aria-label={`Attendee ${i + 1} email`} value={g}
                  onChange={(e) => setGuests((a) => a.map((x, j) => (j === i ? e.target.value : x)))} />
                <Button type="button" variant="ghost" size="icon" aria-label="Remove attendee" onClick={() => setGuests((a) => a.filter((_, j) => j !== i))}><X /></Button>
              </div>
            ))}
            {guests.length < 10 && (
              <Button type="button" variant="outline" size="sm" className="justify-self-start" onClick={() => setGuests((a) => [...a, ""])}><Plus /> Add attendee</Button>
            )}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sm-context">Meeting context (internal, optional)</Label>
            <Textarea id="sm-context" rows={3} maxLength={5000} value={context} onChange={(e) => setContext(e.target.value)}
              placeholder="Who they are, what they need, where the deal stands. Only you and your team see this; the invitee never does." />
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} loading={pending}>Schedule</Button>
        </DialogFooter>
        </>)}
      </DialogContent>
    </Dialog>
  );
}
