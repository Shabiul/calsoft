"use client";
import * as React from "react";
import * as A from "@radix-ui/react-avatar";
import { cn } from "@/lib/utils";

export function Avatar({ src, name, className }: { src?: string | null; name?: string | null; className?: string }) {
  const initials = (name ?? "?").split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join("") || "?";
  return (
    <A.Root className={cn("relative inline-flex size-8 shrink-0 overflow-hidden rounded-full", className)}>
      {src ? <A.Image src={src} alt={name ?? ""} className="size-full object-cover" /> : null}
      <A.Fallback className="flex size-full items-center justify-center bg-brand/15 text-xs font-semibold text-brand">{initials}</A.Fallback>
    </A.Root>
  );
}
