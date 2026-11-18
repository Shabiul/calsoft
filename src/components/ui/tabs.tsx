"use client";
import * as React from "react";
import * as T from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

export const Tabs = T.Root;
export const TabsList = React.forwardRef<React.ComponentRef<typeof T.List>, React.ComponentPropsWithoutRef<typeof T.List>>(
  ({ className, ...p }, ref) => <T.List ref={ref} className={cn("inline-flex h-9 items-center gap-1 rounded-lg bg-muted p-1 text-muted-foreground", className)} {...p} />,
);
TabsList.displayName = "TabsList";
export const TabsTrigger = React.forwardRef<React.ComponentRef<typeof T.Trigger>, React.ComponentPropsWithoutRef<typeof T.Trigger>>(
  ({ className, ...p }, ref) => <T.Trigger ref={ref} className={cn("inline-flex items-center justify-center whitespace-nowrap rounded-md px-3 py-1 text-sm font-medium cursor-pointer data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-sm", className)} {...p} />,
);
TabsTrigger.displayName = "TabsTrigger";
export const TabsContent = React.forwardRef<React.ComponentRef<typeof T.Content>, React.ComponentPropsWithoutRef<typeof T.Content>>(
  ({ className, ...p }, ref) => <T.Content ref={ref} className={cn("mt-4", className)} {...p} />,
);
TabsContent.displayName = "TabsContent";
