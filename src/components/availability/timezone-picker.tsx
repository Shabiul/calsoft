"use client";
import * as React from "react";
import { Check, ChevronDown } from "lucide-react";
import { Input, Popover, PopoverContent, PopoverTrigger } from "@/components/ui";
import { cn } from "@/lib/utils";

function allZones(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    const z = fn ? fn("timeZone") : [];
    if (z.length) return z.includes("UTC") ? z : ["UTC", ...z];
  } catch {
    /* fall through */
  }
  return ["UTC"];
}

function offsetLabel(tz: string): string {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" }).formatToParts(new Date());
    return p.find((x) => x.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

export function TimeZonePicker({ value, onChange, id, disabled }: { value: string; onChange: (tz: string) => void; id?: string; disabled?: boolean }) {
  const [open, setOpen] = React.useState(false);
  const [q, setQ] = React.useState("");
  const zones = React.useMemo(() => {
    const z = allZones();
    return value && !z.includes(value) ? [value, ...z] : z;
  }, [value]);
  const filtered = React.useMemo(() => {
    const s = q.trim().toLowerCase().replace(/\s+/g, "_");
    return (s ? zones.filter((z) => z.toLowerCase().includes(s)) : zones).slice(0, 200);
  }, [zones, q]);

  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (!o) setQ(""); }}>
      <PopoverTrigger asChild>
        <button
          type="button" id={id} disabled={disabled}
          className="flex h-9 w-full cursor-pointer items-center justify-between gap-2 rounded-md border border-input bg-card px-3 text-sm shadow-sm disabled:opacity-50"
          aria-haspopup="listbox" aria-expanded={open}
        >
          <span className="truncate">{value ? `${value.replace(/_/g, " ")} (${offsetLabel(value)})` : "Select a time zone"}</span>
          <ChevronDown className="size-4 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-72 p-2" align="start">
        <Input autoFocus placeholder="Search time zones…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search time zones" />
        <ul role="listbox" className="mt-2 max-h-60 overflow-y-auto">
          {filtered.length === 0 ? <li className="px-2 py-3 text-sm text-muted-foreground">No time zones match “{q}”.</li> : null}
          {filtered.map((z) => (
            <li key={z} role="option" aria-selected={z === value}>
              <button
                type="button"
                onClick={() => { onChange(z); setOpen(false); }}
                className={cn("flex w-full cursor-pointer items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent", z === value && "bg-accent")}
              >
                <span className="truncate">{z.replace(/_/g, " ")}</span>
                <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">{offsetLabel(z)}{z === value ? <Check className="size-3.5" /> : null}</span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
