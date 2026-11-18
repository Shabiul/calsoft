"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cancelSubscriptionAction, startUpgradeAction } from "./actions";

export function UpgradeButton({ planId, provider, label }: { planId: string; provider: string; label: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      disabled={pending}
      onClick={() => start(async () => {
        const r = await startUpgradeAction(planId, provider);
        if (r.ok) window.location.assign(r.data.checkoutUrl);
        else toast.error(r.error.message);
      })}
    >
      {pending ? "Redirecting..." : label}
    </Button>
  );
}

export function CancelSubscriptionButton() {
  const [pending, start] = useTransition();
  const [confirm, setConfirm] = useState(false);
  if (!confirm) return <Button variant="outline" onClick={() => setConfirm(true)}>Cancel subscription</Button>;
  return (
    <span className="flex items-center gap-2">
      <span className="text-sm text-muted-foreground">Cancel at the end of the billing period?</span>
      <Button
        variant="destructive" disabled={pending}
        onClick={() => start(async () => {
          const r = await cancelSubscriptionAction();
          if (r.ok) toast.success("Cancellation requested. Your plan stays active until the period ends."); else toast.error(r.error.message);
          setConfirm(false);
        })}
      >
        {pending ? "Cancelling..." : "Yes, cancel"}
      </Button>
      <Button variant="ghost" onClick={() => setConfirm(false)}>Keep plan</Button>
    </span>
  );
}
