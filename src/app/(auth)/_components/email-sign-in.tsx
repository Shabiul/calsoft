"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Mode = "code" | "password" | "create";

async function post(path: string, body: unknown): Promise<{ ok: boolean; message?: string }> {
  try {
    const r = await fetch(`/api/auth/supabase/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (r.ok) return { ok: true };
    const j = (await r.json().catch(() => ({}))) as { message?: string };
    return { ok: false, message: j.message ?? (r.status === 429 ? "Too many attempts. Wait a minute and try again." : "Something went wrong.") };
  } catch {
    return { ok: false, message: "Network error. Try again." };
  }
}

/** Company email sign-in through Supabase Auth: emailed code (the email also carries a magic link), or email + password. */
export function EmailSignIn({ next }: { next: string }) {
  const [mode, setMode] = useState<Mode>("code");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const done = () => { window.location.assign(next); };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    let r: { ok: boolean; message?: string };
    if (mode === "code" && !sent) {
      r = await post("send", { email });
      if (r.ok) { setSent(true); toast.success("Check your email for a code (or use the link in it)."); }
    } else if (mode === "code") {
      r = await post("verify", { email, code });
      if (r.ok) return done();
    } else if (mode === "password") {
      r = await post("password", { email, password });
      if (r.ok) return done();
    } else {
      r = await post("signup", { email, password });
      if (r.ok) { toast.success("Account created. Confirm your email with the link we sent, then sign in."); setMode("password"); }
    }
    if (!r.ok) toast.error(r.message ?? "Could not sign in");
    setBusy(false);
  }

  const switchTo = (m: Mode) => { setMode(m); setSent(false); setCode(""); setPassword(""); };
  return (
    <form onSubmit={submit} className="space-y-3" aria-label="Sign in with company email">
      <div className="space-y-1.5">
        <Label htmlFor="se-email">Company email</Label>
        <Input id="se-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} disabled={mode === "code" && sent} placeholder="you@company.com" />
      </div>
      {mode === "code" && sent && (
        <div className="space-y-1.5">
          <Label htmlFor="se-code">6-digit code</Label>
          <Input id="se-code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 10))} placeholder="123456" />
        </div>
      )}
      {mode !== "code" && (
        <div className="space-y-1.5">
          <Label htmlFor="se-pass">Password</Label>
          <Input id="se-pass" type="password" autoComplete={mode === "create" ? "new-password" : "current-password"} required minLength={mode === "create" ? 10 : 1} value={password} onChange={(e) => setPassword(e.target.value)} />
          {mode === "create" && <p className="text-xs text-muted-foreground">At least 10 characters.</p>}
        </div>
      )}
      <Button size="lg" className="w-full" loading={busy} type="submit">
        {mode === "code" ? (sent ? "Sign in" : "Email me a code") : mode === "password" ? "Sign in" : "Create login"}
      </Button>
      <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        {mode === "code" ? <button type="button" className="underline" onClick={() => switchTo("password")}>Use a password instead</button>
          : <button type="button" className="underline" onClick={() => switchTo("code")}>Email me a code instead</button>}
        {mode === "password" && <button type="button" className="underline" onClick={() => switchTo("create")}>Create a password login</button>}
        {mode === "create" && <button type="button" className="underline" onClick={() => switchTo("password")}>I already have a login</button>}
        {mode === "code" && sent && <button type="button" className="underline" onClick={() => switchTo("code")}>Use a different email</button>}
      </div>
    </form>
  );
}
