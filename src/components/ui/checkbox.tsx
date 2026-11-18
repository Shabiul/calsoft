"use client";
import * as React from "react";
import * as C from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

export const Checkbox = React.forwardRef<React.ComponentRef<typeof C.Root>, React.ComponentPropsWithoutRef<typeof C.Root>>(
  ({ className, ...p }, ref) => (
    <C.Root ref={ref} className={cn("peer size-4 shrink-0 cursor-pointer rounded-sm border border-input bg-card disabled:opacity-50 data-[state=checked]:border-brand data-[state=checked]:bg-brand data-[state=checked]:text-brand-foreground", className)} {...p}>
      <C.Indicator className="flex items-center justify-center"><Check className="size-3" /></C.Indicator>
    </C.Root>
  ),
);
Checkbox.displayName = "Checkbox";
