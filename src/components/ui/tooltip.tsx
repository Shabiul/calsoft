"use client";
import * as React from "react";
import * as T from "@radix-ui/react-tooltip";
import { cn } from "@/lib/utils";

export const TooltipProvider = T.Provider;
export const Tooltip = T.Root;
export const TooltipTrigger = T.Trigger;
export const TooltipContent = React.forwardRef<React.ComponentRef<typeof T.Content>, React.ComponentPropsWithoutRef<typeof T.Content>>(
  ({ className, sideOffset = 4, ...p }, ref) => (
    <T.Portal><T.Content ref={ref} sideOffset={sideOffset} className={cn("z-50 rounded-md bg-foreground px-2.5 py-1 text-xs text-background shadow-md", className)} {...p} /></T.Portal>
  ),
);
TooltipContent.displayName = "TooltipContent";
