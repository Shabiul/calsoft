"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

function PasswordCard() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const form = e.currentTarget;
    const fd = new FormData(form);
    const next = String(fd.get("new") ?? "");
    if (next !== String(fd.get("confirm") ?? "")) { setError("New passwords do not match."); return; }
    setLoading(true);
    const r = await authClient.changePassword({ currentPassword: String(fd.get("current") ?? ""), newPassword: next, revokeOtherSessions: true });
    setLoading(false);
    if (r.error) { setError(r.error.message ?? "Could not change password"); return; }
    form.reset();
    toast.success("Password changed. Other devices were signed out.");
  }
  return (
    <Card>
      <CardHeader><CardTitle>Password</CardTitle><CardDescription>Changing your password signs out your other devices.</CardDescription></CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4 sm:max-w-sm">
          <div className="grid gap-1.5"><Label htmlFor="current">Current password</Label><Input id="current" name="current" type="password" autoComplete="current-password" required /></div>
          <div className="grid gap-1.5"><Label htmlFor="new">New password</Label><Input id="new" name="new" type="password" minLength={8} autoComplete="new-password" required /></div>
          <div className="grid gap-1.5"><Label htmlFor="confirm">Confirm new password</Label><Input id="confirm" name="confirm" type="password" minLength={8} autoComplete="new-password" required /></div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div><Button type="submit" loading={loading}>Update password</Button></div>
        </form>
      </CardContent>
    </Card>
  );
}

function TwoFactorCard({ enabled, hasPassword }: { enabled: boolean; hasPassword: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<"idle" | "password" | "verify" | "codes" | "disable">("idle");
  const [password, setPassword] = useState("");
  const [totpUri, setTotpUri] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (totpUri) QRCode.toDataURL(totpUri, { margin: 1, width: 192 }).then(setQr).catch(() => setQr(null)); }, [totpUri]);

  async function begin() {
    setBusy(true); setError(null);
    const r = await authClient.twoFactor.enable({ password });
    setBusy(false);
    if (r.error || !r.data || r.data.method !== "totp") { setError(r.error?.message ?? "Could not start setup"); return; }
    setTotpUri(r.data.totpURI); setCodes(r.data.backupCodes); setPassword(""); setStep("verify");
  }
  async function verify() {
    setBusy(true); setError(null);
    const r = await authClient.twoFactor.verifyTotp({ code });
    setBusy(false);
    if (r.error) { setError(r.error.message ?? "Invalid code"); return; }
    setStep("codes"); setCode(""); router.refresh();
  }
  async function disable() {
    setBusy(true); setError(null);
    const r = await authClient.twoFactor.disable({ password });
    setBusy(false);
    if (r.error) { setError(r.error.message ?? "Could not disable"); return; }
    setPassword(""); setStep("idle"); toast.success("Two-factor authentication disabled"); router.refresh();
  }

  const secret = totpUri ? new URL(totpUri).searchParams.get("secret") : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2"><CardTitle>Two-factor authentication</CardTitle>{enabled && <Badge variant="success">Enabled</Badge>}</div>
        <CardDescription>Protect your account with a code from an authenticator app.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:max-w-md">
        {!hasPassword && <p className="text-sm text-muted-foreground">Set a password first (use Forgot password) to manage two-factor authentication.</p>}
        {hasPassword && step === "idle" && (enabled
          ? <div><Button variant="outline" onClick={() => { setError(null); setStep("disable"); }}>Disable</Button></div>
          : <div><Button onClick={() => { setError(null); setStep("password"); }}>Enable</Button></div>)}
        {(step === "password" || step === "disable") && (
          <div className="grid gap-3">
            <Label htmlFor="tfpw">Confirm your password</Label>
            <Input id="tfpw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              <Button loading={busy} onClick={step === "password" ? begin : disable} variant={step === "disable" ? "destructive" : "default"}>{step === "password" ? "Continue" : "Disable 2FA"}</Button>
              <Button variant="ghost" onClick={() => { setStep("idle"); setPassword(""); }}>Cancel</Button>
            </div>
          </div>
        )}
        {step === "verify" && (
          <div className="grid gap-3">
            <p className="text-sm">Scan this QR code with Google Authenticator, 1Password, Authy or similar, then enter the 6-digit code.</p>
            {qr && /* eslint-disable-next-line @next/next/no-img-element */ <img src={qr} alt="2FA QR code" width={192} height={192} className="rounded-md border bg-white p-1" />}
            {secret && <p className="break-all font-mono text-xs text-muted-foreground">Manual key: {secret}</p>}
            <Input inputMode="numeric" placeholder="123456" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2"><Button loading={busy} onClick={verify}>Verify and enable</Button><Button variant="ghost" onClick={() => setStep("idle")}>Cancel</Button></div>
          </div>
        )}
        {step === "codes" && (
          <div className="grid gap-3">
            <p className="text-sm font-medium">Two-factor authentication is on. Save these backup codes somewhere safe; each works once.</p>
            <ul className="grid grid-cols-2 gap-1 rounded-md bg-muted p-3 font-mono text-sm">{codes.map((c) => <li key={c}>{c}</li>)}</ul>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => { void navigator.clipboard.writeText(codes.join("\n")); toast.success("Copied"); }}>Copy codes</Button>
              <Button onClick={() => { setStep("idle"); setCodes([]); }}>Done</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SessionsCard() {
  const router = useRouter();
  const [rows, setRows] = useState<{ token: string; userAgent?: string | null; ipAddress?: string | null; updatedAt: Date | string }[] | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  async function load() {
    const [list, cur] = await Promise.all([authClient.listSessions(), authClient.getSession()]);
    setRows(list.data ?? []);
    setCurrent(cur.data?.session.token ?? null);
  }
  useEffect(() => { void load(); }, []);
  async function revoke(token: string) { await authClient.revokeSession({ token }); toast.success("Session revoked"); await load(); }
  async function revokeOthers() { await authClient.revokeOtherSessions(); toast.success("Signed out of other devices"); await load(); router.refresh(); }
  return (
    <Card>
      <CardHeader><CardTitle>Active sessions</CardTitle><CardDescription>Devices currently signed in to your account.</CardDescription></CardHeader>
      <CardContent className="grid gap-3">
        {rows === null ? <p className="text-sm text-muted-foreground">Loading...</p> : rows.map((s) => (
          <div key={s.token} className="flex items-center justify-between gap-3 text-sm">
            <div className="min-w-0"><p className="truncate">{s.userAgent ?? "Unknown device"}{s.token === current && <Badge className="ml-2">This device</Badge>}</p>
              <p className="text-xs text-muted-foreground">{s.ipAddress ?? "Unknown IP"} · last active {new Date(s.updatedAt).toLocaleString()}</p></div>
            {s.token !== current && <Button size="sm" variant="outline" onClick={() => revoke(s.token)}>Revoke</Button>}
          </div>
        ))}
        {rows && rows.length > 1 && <div><Button variant="secondary" size="sm" onClick={revokeOthers}>Sign out of all other devices</Button></div>}
      </CardContent>
    </Card>
  );
}

export function SecuritySection({ email, hasPassword, twoFactorEnabled, providers }: { email: string; hasPassword: boolean; twoFactorEnabled: boolean; providers: string[] }) {
  return (
    <div className="grid gap-6 lg:max-w-2xl">
      <Card>
        <CardHeader><CardTitle>Sign-in methods</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{email}</span>
          {hasPassword && <Badge variant="secondary">Password</Badge>}
          {providers.map((p) => <Badge key={p} variant="secondary" className="capitalize">{p}</Badge>)}
        </CardContent>
      </Card>
      {hasPassword && <PasswordCard />}
      <TwoFactorCard enabled={twoFactorEnabled} hasPassword={hasPassword} />
      <SessionsCard />
    </div>
  );
}
