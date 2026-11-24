"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function GoogleSignIn({ next }: { next: string }) {
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    const res = await authClient.signIn.social({ provider: "google", callbackURL: next, errorCallbackURL: "/login" });
    if (res?.error) { toast.error(res.error.message ?? "Could not start sign-in"); setBusy(false); }
  }
  return <Button size="lg" variant="outline" className="w-full" loading={busy} onClick={go} type="button">Continue with Google</Button>;
}

export function ZohoSignIn({ next }: { next: string }) {
  const [busy, setBusy] = useState(false);
  async function go() {
    setBusy(true);
    const res = await authClient.signIn.social({ provider: "zoho", callbackURL: next, errorCallbackURL: "/login" });
    if (res?.error) { toast.error(res.error.message ?? "Could not start sign-in"); setBusy(false); }
  }
  return <Button size="lg" className="w-full" loading={busy} onClick={go} type="button">Continue with Zoho</Button>;
}
