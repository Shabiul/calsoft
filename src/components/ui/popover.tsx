"use client";
import * as React from "react";
import * as P from "@radix-ui/react-popover";
import { cn } from "@/lib/utils";

export const Popover = P.Root;
export const PopoverTrigger = P.Trigger;
export const PopoverContent = React.forwardRef<React.ComponentRef<typeof P.Content>, React.ComponentPropsWithoutRef<typeof P.Content>>(
  ({ className, align = "center", sideOffset = 6, ...p }, ref) => (
    <P.Portal><P.Content ref={ref} align={align} sideOffset={sideOffset} className={cn("z-50 w-72 rounded-md border bg-card p-4 text-card-foreground shadow-lg", className)} {...p} /></P.Portal>
  ),
);
PopoverContent.displayName = "PopoverContent";
