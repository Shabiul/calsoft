"use client";
import * as React from "react";
import { Input, Label } from "@/components/ui";
import { cn } from "@/lib/utils";

export function Field({ label, htmlFor, hint, error, children, className }: {
  label: string; htmlFor?: string; hint?: string; error?: string; children: React.ReactNode; className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && !error ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

/** Number input that maps empty string to null. */
export function NumberInput({ value, onChange, min, max, id, placeholder, invalid, step }: {
  value: number | null; onChange: (v: number | null) => void; min?: number; max?: number; id?: string; placeholder?: string; invalid?: boolean; step?: number;
}) {
  return (
    <Input
      id={id} type="number" inputMode="numeric" min={min} max={max} step={step} placeholder={placeholder} aria-invalid={invalid || undefined}
      value={value ?? ""}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") return onChange(null);
        const n = Number(raw);
        if (Number.isFinite(n)) onChange(n);
      }}
    />
  );
}

export function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border bg-card p-5 shadow-sm">
      <h3 className="text-base font-semibold">{title}</h3>
      {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
      <div className="mt-4 grid gap-4">{children}</div>
    </section>
  );
}
