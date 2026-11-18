"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export function TwoFactorForm() {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [backup, setBackup] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const code = String(new FormData(e.currentTarget).get("code") ?? "").trim();
    const res = backup ? await authClient.twoFactor.verifyBackupCode({ code }) : await authClient.twoFactor.verifyTotp({ code, trustDevice: true });
    setLoading(false);
    if (res.error) { setError(res.error.message ?? "Invalid code"); return; }
    window.location.href = "/dashboard";
  }
  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="code">{backup ? "Backup code" : "Authentication code"}</Label>
        <Input id="code" name="code" inputMode={backup ? "text" : "numeric"} autoComplete="one-time-code" required autoFocus />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" loading={loading}>Verify</Button>
      <button type="button" className="text-sm text-muted-foreground hover:underline" onClick={() => setBackup(!backup)}>{backup ? "Use authenticator code" : "Use a backup code"}</button>
    </form>
  );
}
