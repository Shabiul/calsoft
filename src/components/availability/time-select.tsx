"use client";
import * as React from "react";
import { cn } from "@/lib/utils";

const STEP = 15;
const base: string[] = [];
for (let m = 0; m < 24 * 60; m += STEP) base.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);

export function formatTime(t: string, h12 = true): string {
  const [h, m] = t.split(":").map(Number);
  if (!h12) return t;
  const suffix = h >= 12 ? "pm" : "am";
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")}${suffix}`;
}

export function TimeSelect({ value, onChange, label, className, invalid }: { value: string; onChange: (v: string) => void; label: string; className?: string; invalid?: boolean }) {
  const options = base.includes(value) ? base : [...base, value].sort();
  return (
    <select
      aria-label={label} aria-invalid={invalid || undefined} value={value} onChange={(e) => onChange(e.target.value)}
      className={cn("h-9 cursor-pointer rounded-md border border-input bg-card px-2 text-sm shadow-sm aria-[invalid=true]:border-destructive", className)}
    >
      {options.map((o) => <option key={o} value={o}>{formatTime(o)}</option>)}
    </select>
  );
}
