import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Inbox } from "lucide-react";
import { Badge, Button, EmptyState, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { isAppError } from "@/server/errors";
import { getForm, listRoutableEventTypes, listSubmissions, type SubmissionDto } from "@/server/services/routing-forms";
import { fmtDateTime } from "@/components/contacts/format";

export const metadata = { title: "Routing form submissions" };
type SP = Promise<Record<string, string | string[] | undefined>>;

export default function SubmissionsPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <Link href="/dashboard/routing-forms" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Routing forms</Link>
      <Suspense fallback={<div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-64" /></div>}>
        <Content params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

function outcomeText(o: SubmissionDto["outcome"], eventTitles: Map<string, string>): string {
  const how = o.source === "rule" ? `rule ${(o.ruleIndex ?? 0) + 1}` : o.source === "fallback" ? "fallback" : "no match";
  if (o.type === "event") return `${o.eventTypeId ? eventTitles.get(o.eventTypeId) ?? "Event type" : "Event type"}${o.unavailable ? " (unavailable)" : ""} via ${how}`;
  if (o.type === "url") return `${o.url} via ${how}`;
  if (o.type === "message") return `Message via ${how}`;
  return "No destination";
}

async function Content({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: SP }) {
  const user = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const sp = await searchParams;
  const page = Math.max(parseInt((Array.isArray(sp.page) ? sp.page[0] : sp.page) ?? "1", 10) || 1, 1);
  let form, subs;
  try {
    form = await getForm(user.id, id);
    subs = await listSubmissions(user.id, id, { page, pageSize: 25 });
  } catch (e) { if (isAppError(e) && e.status === 404) notFound(); throw e; }

  const eventTitles = new Map((await listRoutableEventTypes(user.id)).map((e) => [e.id, e.title]));
  const labels = new Map(form.config.fields.map((f) => [f.id, f.label || f.id]));
  const pages = Math.max(Math.ceil(subs.total / subs.pageSize), 1);
  const base = `/dashboard/routing-forms/${id}/submissions`;
  const tz = user.timeZone;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{form.name}</h1>
          <p className="text-sm text-muted-foreground">{subs.total} submission{subs.total === 1 ? "" : "s"}</p>
        </div>
        <Button asChild variant="outline"><Link href={`/dashboard/routing-forms/${id}`}>Edit form</Link></Button>
      </div>
      {subs.rows.length === 0 ? (
        <EmptyState icon={<Inbox />} title="No submissions yet" description="Responses appear here once people fill in your public form." />
      ) : (
        <ul className="space-y-3">
          {subs.rows.map((s) => (
            <li key={s.id} className="rounded-xl border bg-card p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-medium">{s.name || s.email || "Anonymous"}{s.name && s.email ? <span className="ml-2 text-sm font-normal text-muted-foreground">{s.email}</span> : null}</div>
                <span className="text-xs text-muted-foreground">{fmtDateTime(s.createdAt, tz)}</span>
              </div>
              <div className="mt-2"><Badge variant="secondary">{outcomeText(s.outcome, eventTitles)}</Badge></div>
              <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                {Object.entries(s.answers).map(([k, v]) => (
                  <div key={k} className="flex gap-2"><dt className="text-muted-foreground">{labels.get(k) ?? k}:</dt><dd className="min-w-0 break-words">{Array.isArray(v) ? v.join(", ") : v}</dd></div>
                ))}
              </dl>
            </li>
          ))}
        </ul>
      )}
      {subs.total > subs.pageSize && (
        <nav className="flex items-center justify-between text-sm text-muted-foreground" aria-label="Pagination">
          {page > 1 ? <Button asChild variant="outline" size="sm"><Link href={`${base}?page=${page - 1}`}>Previous</Link></Button> : <Button variant="outline" size="sm" disabled>Previous</Button>}
          <span>Page {page} of {pages}</span>
          {page < pages ? <Button asChild variant="outline" size="sm"><Link href={`${base}?page=${page + 1}`}>Next</Link></Button> : <Button variant="outline" size="sm" disabled>Next</Button>}
        </nav>
      )}
    </div>
  );
}
