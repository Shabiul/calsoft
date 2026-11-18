import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Badge, Card, CardContent, CardHeader, CardTitle, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { isAppError } from "@/server/errors";
import { getContactDetail, type ContactBooking } from "@/server/services/contacts";
import { NotesPanel, ProfileEditor } from "@/components/contacts/contact-tools";
import { EVENT_LABEL, STATUS_LABEL, STATUS_VARIANT, fmtDateTime } from "@/components/contacts/format";

export const metadata = { title: "Contact" };

export default function ContactPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <Link href="/dashboard/contacts" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Contacts</Link>
      <Suspense fallback={<div className="space-y-3"><Skeleton className="h-24" /><Skeleton className="h-64" /></div>}>
        <Content params={params} />
      </Suspense>
    </div>
  );
}

function BookingList({ items, tz, empty }: { items: ContactBooking[]; tz: string; empty: string }) {
  if (!items.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  return (
    <ul className="divide-y">
      {items.map((b) => (
        <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
          <div className="flex items-center gap-2">
            <span className="size-2.5 rounded-full bg-brand" style={b.color ? { background: b.color } : undefined} aria-hidden />
            <span className="font-medium">{b.title}</span>
            <span className="text-muted-foreground">with {b.hostName}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">{fmtDateTime(b.startsAt, tz)}</span>
            <Badge variant={STATUS_VARIANT[b.status] ?? "secondary"}>{STATUS_LABEL[b.status] ?? b.status}</Badge>
          </div>
        </li>
      ))}
    </ul>
  );
}

async function Content({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let d;
  try { d = await getContactDetail(user.id, id); } catch (e) { if (isAppError(e) && e.status === 404) notFound(); throw e; }
  const tz = user.timeZone;
  const c = d.contact;
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{c.name || c.email}</h1>
        <p className="text-sm text-muted-foreground">{c.email} · Added {fmtDateTime(c.createdAt, tz)}</p>
      </div>
      <Card><CardHeader><CardTitle>Profile</CardTitle></CardHeader><CardContent><ProfileEditor contactId={c.id} initial={{ name: c.name ?? "", phone: c.phone ?? "", timeZone: c.timeZone ?? "" }} /></CardContent></Card>
      <Card><CardHeader><CardTitle>Upcoming meetings</CardTitle></CardHeader><CardContent><BookingList items={d.upcoming} tz={tz} empty="No upcoming meetings." /></CardContent></Card>
      <Card><CardHeader><CardTitle>Past meetings</CardTitle></CardHeader><CardContent><BookingList items={d.past} tz={tz} empty="No past meetings." /></CardContent></Card>
      <Card><CardHeader><CardTitle>Notes</CardTitle></CardHeader><CardContent>
        <NotesPanel contactId={c.id} notes={d.notes.map((n) => ({ id: n.id, body: n.body, createdAt: n.createdAt, authorName: n.authorName, canDelete: n.canDelete, when: fmtDateTime(n.createdAt, tz) }))} />
      </CardContent></Card>
      <Card><CardHeader><CardTitle>History</CardTitle></CardHeader><CardContent>
        {d.history.length === 0 ? <p className="text-sm text-muted-foreground">No activity yet.</p> : (
          <ol className="space-y-2 text-sm">
            {d.history.map((h) => (
              <li key={h.id} className="flex flex-wrap justify-between gap-2">
                <span>{EVENT_LABEL[h.type] ?? h.type.replace(/_/g, " ")} <span className="text-muted-foreground">· {h.title}</span></span>
                <span className="text-muted-foreground">{fmtDateTime(h.createdAt, tz)}</span>
              </li>
            ))}
          </ol>
        )}
      </CardContent></Card>
    </div>
  );
}
