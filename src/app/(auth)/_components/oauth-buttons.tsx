"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

export function OAuthButtons({ google, microsoft, next }: { google: boolean; microsoft: boolean; next: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  if (!google && !microsoft) return null;
  async function go(provider: "google" | "microsoft") {
    setBusy(provider);
    const res = await authClient.signIn.social({ provider, callbackURL: next });
    if (res?.error) { toast.error(res.error.message ?? "Could not start sign-in"); setBusy(null); }
  }
  return (
    <>
      <div className="grid gap-2">
        {google && <Button variant="secondary" loading={busy === "google"} onClick={() => go("google")} type="button">Continue with Google</Button>}
        {microsoft && <Button variant="secondary" loading={busy === "microsoft"} onClick={() => go("microsoft")} type="button">Continue with Microsoft</Button>}
      </div>
      <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />or<span className="h-px flex-1 bg-border" /></div>
    </>
  );
}
