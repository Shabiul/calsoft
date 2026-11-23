import { Suspense } from "react";
import { NotebookPen } from "lucide-react";
import { DateTime } from "luxon";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { Badge, Button, EmptyState, Input, PageHeader, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { db, schema } from "@/server/db";
import { notesUrl } from "@/server/notetaker";

export const metadata = { title: "Meeting notes" };

type SP = Promise<{ q?: string | string[] }>;
const { meetingNotes: N, bookings: B, eventTypes: E } = schema;

export default function NotesSearchPage({ searchParams }: { searchParams: SP }) {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader title="Meeting notes" description="Search transcripts, AI summaries, shared notes and chat from your meetings." />
      <Suspense fallback={<div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div>}>
        <Results searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

/** Text around the first match (or the start of the summary) for the result card. */
function snippet(text: string, q: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const i = q ? flat.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return flat.slice(0, 200) + (flat.length > 200 ? "…" : "");
  const start = Math.max(0, i - 80);
  return (start ? "…" : "") + flat.slice(start, i + q.length + 120) + (i + q.length + 120 < flat.length ? "…" : "");
}

async function Results({ searchParams }: { searchParams: SP }) {
  const user = await requireUser();
  const raw = (await searchParams).q;
  const q = (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, 100) ?? "";
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  // ponytail: ILIKE scan over the host's own notes; switch to Postgres full-text search (tsvector + GIN) if notes grow large.
  const rows = await db.select({
    id: B.id, startsAt: B.startsAt, title: E.title, content: N.content, summary: N.summary, transcript: N.transcript,
    chat: sql<string>`coalesce(${N.chat}::text, '')`, botStatus: N.botStatus,
  }).from(N).innerJoin(B, eq(B.id, N.bookingId)).innerJoin(E, eq(E.id, B.eventTypeId))
    .where(and(eq(B.hostUserId, user.id), q ? or(ilike(E.title, like), ilike(N.content, like), ilike(N.summary, like), ilike(N.transcript, like), sql`${N.chat}::text ilike ${like}`) : undefined))
    .orderBy(desc(B.startsAt)).limit(50);

  return (
    <>
      <form className="mb-4 flex gap-2" role="search">
        <Input name="q" defaultValue={q} placeholder="Search what was said, decided or written…" aria-label="Search meeting notes" />
        <Button type="submit">Search</Button>
      </form>
      {rows.length === 0 ? (
        <EmptyState icon={<NotebookPen />} title={q ? "No matching meetings" : "No meeting notes yet"}
          description={q ? "Try other words: a name, topic or decision." : "Notes appear here once a meeting has shared notes or a notetaker transcript."} />
      ) : (
        <ul className="grid gap-3">
          {rows.map((r) => {
            const where = [
              ["Summary", r.summary], ["Transcript", r.transcript], ["Notes", r.content], ["Chat", r.chat],
            ].find(([, t]) => t && (!q || t.toLowerCase().includes(q.toLowerCase())));
            return (
              <li key={r.id} className="rounded-xl border bg-card p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <a href={notesUrl(r.id)} target="_blank" rel="noreferrer" className="font-medium hover:underline">{r.title}</a>
                  <span className="text-sm text-muted-foreground">{DateTime.fromJSDate(r.startsAt).setZone(user.timeZone).toFormat("ccc, LLL d, yyyy · h:mm a")}</span>
                </div>
                {where && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    <Badge variant="secondary" className="mr-2">{where[0]}</Badge>{snippet(where[1]!, q)}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
