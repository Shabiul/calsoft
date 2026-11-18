"use client";
import Link from "next/link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export function ResetForm() {
  const params = useSearchParams();
  const token = params.get("token");
  const [error, setError] = useState<string | null>(params.get("error") ? "This reset link is invalid or has expired." : null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    const password = String(fd.get("password") ?? "");
    if (password !== String(fd.get("confirm") ?? "")) { setError("Passwords do not match."); return; }
    if (!token) { setError("Missing reset token. Request a new link."); return; }
    setLoading(true);
    const res = await authClient.resetPassword({ newPassword: password, token });
    setLoading(false);
    if (res.error) { setError(res.error.message ?? "Could not reset password"); return; }
    setDone(true);
  }

  if (done) return <p className="text-sm">Your password has been updated. <Link href="/login" className="text-brand hover:underline">Sign in</Link></p>;
  if (!token) return <p className="text-sm text-destructive">{error ?? "Missing reset token."} <Link href="/forgot-password" className="underline">Request a new link</Link></p>;
  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <div className="grid gap-1.5"><Label htmlFor="password">New password</Label><Input id="password" name="password" type="password" minLength={8} autoComplete="new-password" required /></div>
      <div className="grid gap-1.5"><Label htmlFor="confirm">Confirm password</Label><Input id="confirm" name="confirm" type="password" minLength={8} autoComplete="new-password" required /></div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" loading={loading}>Update password</Button>
    </form>
  );
}
