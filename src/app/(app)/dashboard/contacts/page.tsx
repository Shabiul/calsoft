import { Suspense } from "react";
import Link from "next/link";
import { Contact as ContactIcon, Download } from "lucide-react";
import { Badge, Button, DataTable, EmptyState, PageHeader, Skeleton, type Column } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { findDuplicateGroups, listContacts, type ContactFilter, type ContactListItem, type ContactSort } from "@/server/services/contacts";
import { AddContactForm, DuplicatesPanel } from "@/components/contacts/contact-tools";
import { fmtDate, fmtDateTime } from "@/components/contacts/format";

export const metadata = { title: "Contacts" };

type SP = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const FILTERS: { v: ContactFilter; label: string }[] = [
  { v: "all", label: "All contacts" }, { v: "upcoming", label: "Has upcoming meeting" }, { v: "booked", label: "Has booked" }, { v: "never", label: "Never booked" },
];
const SORTS: { v: ContactSort; label: string }[] = [
  { v: "recent", label: "Recently updated" }, { v: "name", label: "Name" }, { v: "email", label: "Email" }, { v: "bookings", label: "Most bookings" },
];
const selectCls = "h-9 rounded-md border border-input bg-card px-3 text-sm shadow-sm";

export default function ContactsPage({ searchParams }: { searchParams: SP }) {
  return (
    <div className="mx-auto w-full max-w-5xl">
      <PageHeader title="Contacts" description="People who have booked with you. Contacts are created automatically from bookings." />
      <Suspense fallback={<div className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-64" /></div>}>
        <Content searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Content({ searchParams }: { searchParams: SP }) {
  const user = await requireUser();
  const sp = await searchParams;
  const q = first(sp.q)?.slice(0, 100) ?? "";
  const filter = FILTERS.find((f) => f.v === first(sp.filter))?.v ?? "all";
  const sort = SORTS.find((s) => s.v === first(sp.sort))?.v ?? "recent";
  const page = Math.max(parseInt(first(sp.page) ?? "1", 10) || 1, 1);
  const [res, dups] = await Promise.all([listContacts(user.id, { q, filter, sort, page, pageSize: 25 }), findDuplicateGroups(user.id)]);
  const tz = user.timeZone;
  const pages = Math.max(Math.ceil(res.total / res.pageSize), 1);
  const qs = (p: number) => {
    const u = new URLSearchParams();
    if (q) u.set("q", q);
    if (filter !== "all") u.set("filter", filter);
    if (sort !== "recent") u.set("sort", sort);
    if (p > 1) u.set("page", String(p));
    const s = u.toString();
    return s ? `?${s}` : "";
  };

  const columns: Column<ContactListItem>[] = [
    { key: "name", header: "Contact", cell: (c) => (
      <Link href={`/dashboard/contacts/${c.id}`} className="block min-w-0">
        <span className="font-medium hover:underline">{c.name || c.email}</span>
        {c.name ? <span className="block truncate text-xs text-muted-foreground">{c.email}</span> : null}
      </Link>
    ) },
    { key: "bookings", header: "Bookings", cell: (c) => c.bookingCount },
    { key: "next", header: "Next meeting", cell: (c) => c.nextMeetingAt ? <Badge variant="default">{fmtDateTime(c.nextMeetingAt, tz)}</Badge> : <span className="text-muted-foreground">-</span> },
    { key: "last", header: "Last meeting", cell: (c) => fmtDate(c.lastMeetingAt, tz) },
    { key: "created", header: "Added", cell: (c) => fmtDate(c.createdAt, tz) },
  ];

  return (
    <>
      <DuplicatesPanel groups={dups} />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <form method="get" className="flex flex-1 flex-wrap items-end gap-2" role="search">
          <div className="min-w-48 flex-1">
            <label htmlFor="c-q" className="sr-only">Search contacts</label>
            <input id="c-q" name="q" defaultValue={q} placeholder="Search name, email or phone" maxLength={100}
              className="flex h-9 w-full rounded-md border border-input bg-card px-3 text-sm shadow-sm" />
          </div>
          <label className="sr-only" htmlFor="c-filter">Filter</label>
          <select id="c-filter" name="filter" defaultValue={filter} className={selectCls}>{FILTERS.map((f) => <option key={f.v} value={f.v}>{f.label}</option>)}</select>
          <label className="sr-only" htmlFor="c-sort">Sort</label>
          <select id="c-sort" name="sort" defaultValue={sort} className={selectCls}>{SORTS.map((s) => <option key={s.v} value={s.v}>{s.label}</option>)}</select>
          <Button type="submit" variant="secondary">Apply</Button>
          {(q || filter !== "all" || sort !== "recent") && <Button asChild variant="ghost"><Link href="/dashboard/contacts">Clear</Link></Button>}
        </form>
        <Button asChild variant="outline"><a href={`/dashboard/contacts/export${qs(1)}`} download><Download /> Export CSV</a></Button>
        <AddContactForm />
      </div>

      <DataTable
        columns={columns} rows={res.rows} rowKey={(c) => c.id}
        empty={q || filter !== "all" ? (
          <EmptyState icon={<ContactIcon />} title="No contacts match" description="Try a different search or filter." action={<Button asChild variant="outline"><Link href="/dashboard/contacts">Clear filters</Link></Button>} />
        ) : (
          <EmptyState icon={<ContactIcon />} title="No contacts yet" description="When someone books a meeting with you, they appear here automatically. You can also add a contact manually." />
        )}
      />
      {res.total > 0 && (
        <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
          <span>{(page - 1) * res.pageSize + 1}-{Math.min(page * res.pageSize, res.total)} of {res.total}</span>
          <nav className="flex items-center gap-2" aria-label="Pagination">
            {page > 1 ? <Button asChild variant="outline" size="sm"><Link href={`/dashboard/contacts${qs(page - 1)}`}>Previous</Link></Button> : <Button variant="outline" size="sm" disabled>Previous</Button>}
            <span>Page {page} of {pages}</span>
            {page < pages ? <Button asChild variant="outline" size="sm"><Link href={`/dashboard/contacts${qs(page + 1)}`}>Next</Link></Button> : <Button variant="outline" size="sm" disabled>Next</Button>}
          </nav>
        </div>
      )}
    </>
  );
}
