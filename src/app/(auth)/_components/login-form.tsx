"use client";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export function LoginForm({ next }: { next: string }) {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [unverified, setUnverified] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setUnverified(null);
    const fd = new FormData(e.currentTarget);
    const email = String(fd.get("email") ?? "").trim();
    setLoading(true);
    const res = await authClient.signIn.email({ email, password: String(fd.get("password") ?? ""), callbackURL: next });
    setLoading(false);
    if (res.error) {
      if (res.error.status === 403) setUnverified(email);
      setError(res.error.message ?? "Invalid email or password");
      return;
    }
    if (res.data && "twoFactorRedirect" in res.data && res.data.twoFactorRedirect) return; // client plugin redirects
    window.location.href = next;
  }

  async function resend() {
    if (!unverified) return;
    const r = await authClient.sendVerificationEmail({ email: unverified, callbackURL: next });
    setError(r.error ? (r.error.message ?? "Could not send email") : "Verification email sent. Check your inbox.");
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <div className="grid gap-1.5"><Label htmlFor="email">Email</Label><Input id="email" name="email" type="email" autoComplete="email" required /></div>
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">Password</Label>
          <Link href="/forgot-password" className="text-xs text-brand hover:underline">Forgot password?</Link>
        </div>
        <Input id="password" name="password" type="password" autoComplete="current-password" required />
      </div>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
          {unverified && <> <button type="button" onClick={resend} className="underline">Resend email</button></>}
        </p>
      )}
      <Button type="submit" loading={loading}>Sign in</Button>
    </form>
  );
}
