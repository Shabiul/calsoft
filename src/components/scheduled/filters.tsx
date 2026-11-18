"use client";
import { useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Download, Search } from "lucide-react";
import { Button, Input } from "@/components/ui";

export function ScheduledFilters({ events, hosts }: { events: { id: string; title: string }[]; hosts: { id: string; name: string }[] }) {
  const router = useRouter();
  const path = usePathname();
  const sp = useSearchParams();
  const [q, setQ] = useState(sp.get("q") ?? "");

  const push = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(sp.toString());
    for (const [k, v] of Object.entries(patch)) { if (v) next.set(k, v); else next.delete(k); }
    next.delete("page"); next.delete("b");
    const s = next.toString();
    router.push(s ? `${path}?${s}` : path);
  };
  const exportHref = () => {
    const next = new URLSearchParams();
    for (const k of ["tab", "q", "event", "host"]) { const v = sp.get(k); if (v) next.set(k, v); }
    return `/dashboard/scheduled/export?${next.toString()}`;
  };
  const sel = "h-9 min-w-0 rounded-md border border-input bg-card px-2 text-sm";

  return (
    <form role="search" className="mb-4 flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); push({ q: q.trim() || null }); }}>
      <div className="relative min-w-52 flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
        <Input aria-label="Search invitees or events" className="pl-8" placeholder="Search name, email or event" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <select aria-label="Filter by event type" className={sel} value={sp.get("event") ?? ""} onChange={(e) => push({ event: e.target.value || null })}>
        <option value="">All event types</option>
        {events.map((e) => <option key={e.id} value={e.id}>{e.title}</option>)}
      </select>
      {hosts.length > 1 && (
        <select aria-label="Filter by host" className={sel} value={sp.get("host") ?? ""} onChange={(e) => push({ host: e.target.value || null })}>
          <option value="">All hosts</option>
          {hosts.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
        </select>
      )}
      <Button type="submit" variant="secondary">Search</Button>
      <Button asChild variant="outline"><a href={exportHref()} download><Download /> Export CSV</a></Button>
    </form>
  );
}
