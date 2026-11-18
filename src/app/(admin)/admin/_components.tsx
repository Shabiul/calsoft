import Link from "next/link";
import { Badge } from "@/components/ui/badge";

export type SP = Promise<Record<string, string | string[] | undefined>>;
export const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export function Flash({ sp }: { sp: Record<string, string | string[] | undefined> }) {
  const err = one(sp.error), ok = one(sp.ok);
  if (err) return <div role="alert" className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</div>;
  if (ok) return <div role="status" className="mb-4 rounded-md border border-success/30 bg-success/10 px-3 py-2 text-sm text-success">Saved.</div>;
  return null;
}

export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function StatusBadge({ ok, label }: { ok: boolean; label?: string }) {
  return <Badge variant={ok ? "success" : "destructive"}>{label ?? (ok ? "OK" : "Down")}</Badge>;
}

export function Pager({ base, params, page, pages }: { base: string; params: Record<string, string>; page: number; pages: number }) {
  if (pages <= 1) return null;
  const href = (p: number) => {
    const q = new URLSearchParams({ ...params, page: String(p) });
    for (const [k, v] of [...q]) if (!v) q.delete(k);
    return `${base}?${q}`;
  };
  return (
    <div className="mt-4 flex items-center justify-between text-sm">
      <span className="text-muted-foreground">Page {page} of {pages}</span>
      <div className="flex gap-2">
        {page > 1 ? <Link className="rounded-md border px-3 py-1 hover:bg-accent" href={href(page - 1)}>Previous</Link> : null}
        {page < pages ? <Link className="rounded-md border px-3 py-1 hover:bg-accent" href={href(page + 1)}>Next</Link> : null}
      </div>
    </div>
  );
}

export const fmt = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "-");
export const inputCls = "h-9 rounded-md border border-input bg-background px-3 text-sm";
