import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Simple, accessible, theme-aware charts (hand-built SVG/CSS; colors come from CSS variables). */

export function StatCard({ label, value, hint, estimate }: { label: string; value: ReactNode; hint?: ReactNode; estimate?: boolean }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
        {estimate && <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] normal-case text-warning" title="Approximate: see the note under this card">estimate</span>}
      </div>
      <div className="mt-1 text-2xl font-semibold tabular-nums">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

export function Panel({ title, description, children, className }: { title: string; description?: string; children: ReactNode; className?: string }) {
  return (
    <section className={cn("rounded-xl border bg-card p-5", className)} aria-label={title}>
      <h2 className="text-sm font-semibold">{title}</h2>
      {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </section>
  );
}

const niceMax = (m: number) => {
  if (m <= 5) return Math.max(m, 1);
  const p = 10 ** Math.floor(Math.log10(m));
  return Math.ceil(m / p) * p;
};

/** Vertical bar chart. `labels` are shown sparsely on the axis; every bar has a <title> tooltip and the whole chart a text summary. */
export function BarChart({ data, ariaLabel, height = 160, every = 1 }: {
  data: { label: string; value: number; secondary?: number }[]; ariaLabel: string; height?: number; every?: number;
}) {
  const W = 600, H = height, padB = 22, padT = 8, padL = 28;
  const max = niceMax(Math.max(0, ...data.map((d) => d.value)));
  const bw = (W - padL) / Math.max(data.length, 1);
  const total = data.reduce((s, d) => s + d.value, 0);
  const peak = data.reduce((b, d) => (d.value > b.value ? d : b), data[0] ?? { label: "", value: 0 });
  const y = (v: number) => padT + (H - padT - padB) * (1 - v / max);
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${ariaLabel}. Total ${total}.${total ? ` Highest: ${peak.label} with ${peak.value}.` : ""}`}>
        {[0, 0.5, 1].map((t) => (
          <g key={t}>
            <line x1={padL} x2={W} y1={y(max * t)} y2={y(max * t)} stroke="var(--border)" strokeWidth="1" />
            <text x={padL - 4} y={y(max * t) + 3} textAnchor="end" fontSize="9" fill="var(--muted-foreground)">{Math.round(max * t)}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const x = padL + i * bw;
          const h = (H - padT - padB) * (d.value / max);
          return (
            <g key={`${d.label}-${i}`}>
              <rect x={x + bw * 0.15} y={y(d.value)} width={Math.max(bw * 0.7, 1)} height={Math.max(h, d.value > 0 ? 1 : 0)} rx="2" fill="var(--brand)">
                <title>{`${d.label}: ${d.value}`}</title>
              </rect>
              {i % every === 0 && <text x={x + bw / 2} y={H - 7} textAnchor="middle" fontSize="9" fill="var(--muted-foreground)">{d.label}</text>}
            </g>
          );
        })}
      </svg>
      <figcaption className="sr-only">
        <table><caption>{ariaLabel}</caption><tbody>{data.map((d, i) => <tr key={i}><th scope="row">{d.label}</th><td>{d.value}</td></tr>)}</tbody></table>
      </figcaption>
    </figure>
  );
}

/** Horizontal ranked bars with values inline (best for categorical comparisons). */
export function RankBars({ rows, empty, valueLabel = (v: number) => String(v) }: {
  rows: { key: string; label: string; value: number; sub?: string; color?: string | null }[]; empty: string; valueLabel?: (v: number) => string;
}) {
  if (!rows.length) return <p className="text-sm text-muted-foreground">{empty}</p>;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.key}>
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate font-medium">{r.label}</span>
            <span className="shrink-0 tabular-nums">{valueLabel(r.value)}{r.sub ? <span className="ml-2 text-xs text-muted-foreground">{r.sub}</span> : null}</span>
          </div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted" role="presentation">
            <div className="h-full rounded-full bg-brand" style={{ width: `${(r.value / max) * 100}%`, ...(r.color ? { background: r.color } : {}) }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
