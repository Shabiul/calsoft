"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";

const GoogleLogo = () => (
  <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
    <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.9 2.4 30.4 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/>
    <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 7l7.2 5.6c4.3-3.9 6.8-9.7 6.8-17.1z"/>
    <path fill="#FBBC05" d="M10.5 28.7a14.5 14.5 0 0 1 0-9.4l-7.9-6.1a24 24 0 0 0 0 21.6l7.9-6.1z"/>
    <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.2-5.6c-2 1.4-4.6 2.2-8.7 2.2-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/>
  </svg>
);

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
        {google && (
          <Button variant="outline" size="lg" className="w-full gap-3 bg-white text-neutral-900 hover:bg-neutral-100 dark:bg-white dark:hover:bg-neutral-100" loading={busy === "google"} onClick={() => go("google")} type="button">
            <GoogleLogo /> Continue with Google
          </Button>
        )}
        {microsoft && <Button variant="secondary" loading={busy === "microsoft"} onClick={() => go("microsoft")} type="button">Continue with Microsoft</Button>}
      </div>
      <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground"><span className="h-px flex-1 bg-border" />or use email<span className="h-px flex-1 bg-border" /></div>
    </>
  );
}
