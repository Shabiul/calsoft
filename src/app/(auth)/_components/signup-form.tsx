"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { validateUsername, slugifyUsername } from "@/lib/username";

type Avail = { state: "idle" | "checking" | "ok" | "bad"; message?: string; suggestions: string[] };

export function SignupForm({ next }: { next: string }) {
  const [name, setName] = useState("");
  const [username, setUsername] = useState("");
  const [touchedUsername, setTouchedUsername] = useState(false);
  const [avail, setAvail] = useState<Avail>({ state: "idle", suggestions: [] });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const seq = useRef(0);

  // auto-suggest username from name until the user edits it
  useEffect(() => {
    if (!touchedUsername && name.trim().length >= 2) setUsername(slugifyUsername(name));
  }, [name, touchedUsername]);

  useEffect(() => {
    if (!username) { setAvail({ state: "idle", suggestions: [] }); return; }
    const local = validateUsername(username);
    if (!local.ok) { setAvail({ state: "bad", message: local.message, suggestions: [] }); return; }
    const id = ++seq.current;
    setAvail((a) => ({ ...a, state: "checking" }));
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/username?u=${encodeURIComponent(local.username)}&base=${encodeURIComponent(name || local.username)}`);
        const j = (await r.json()) as { available: boolean; message?: string; suggestions: string[] };
        if (id !== seq.current) return;
        setAvail(j.available ? { state: "ok", suggestions: [] } : { state: "bad", message: j.message ?? "Unavailable", suggestions: j.suggestions ?? [] });
      } catch {
        if (id === seq.current) setAvail({ state: "idle", suggestions: [] });
      }
    }, 350);
    return () => clearTimeout(t);
  }, [username, name]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const fd = new FormData(e.currentTarget);
    const v = validateUsername(username);
    if (!v.ok) { setError(v.message); return; }
    if (avail.state === "bad") { setError(avail.message ?? "Choose a different username"); return; }
    setLoading(true);
    const email = String(fd.get("email") ?? "").trim();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const res = await authClient.signUp.email({
      name: name.trim(), email, password: String(fd.get("password") ?? ""), username: v.username, timeZone: tz, callbackURL: next,
    });
    setLoading(false);
    if (res.error) { setError(res.error.message ?? "Could not create account"); return; }
    // With email verification required there is no session yet.
    if (res.data && !res.data.token) { setSent(email); return; }
    window.location.href = next;
  }

  if (sent) {
    return (
      <div className="text-center text-sm">
        <h2 className="text-lg font-semibold">Check your inbox</h2>
        <p className="mt-2 text-muted-foreground">We sent a verification link to <b className="text-foreground">{sent}</b>. Click it to activate your account.</p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="grid gap-4">
      <div className="grid gap-1.5"><Label htmlFor="name">Full name</Label>
        <Input id="name" name="name" autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="grid gap-1.5"><Label htmlFor="email">Work email</Label><Input id="email" name="email" type="email" autoComplete="email" required /></div>
      <div className="grid gap-1.5">
        <Label htmlFor="username">Your booking link</Label>
        <div className="flex items-center rounded-md border border-input bg-card shadow-sm focus-within:outline-2 focus-within:outline-ring">
          <span className="pl-3 text-sm text-muted-foreground">/</span>
          <input id="username" name="username" value={username} autoComplete="off" spellCheck={false} required
            onChange={(e) => { setTouchedUsername(true); setUsername(e.target.value.toLowerCase()); }}
            className="h-9 w-full bg-transparent px-1 text-sm outline-none" aria-invalid={avail.state === "bad"} />
        </div>
        <p className={`text-xs ${avail.state === "bad" ? "text-destructive" : avail.state === "ok" ? "text-success" : "text-muted-foreground"}`}>
          {avail.state === "checking" ? "Checking..." : avail.state === "ok" ? "Available" : avail.state === "bad" ? avail.message : "Letters, numbers, hyphens and underscores."}
        </p>
        {avail.suggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {avail.suggestions.map((s) => (
              <button key={s} type="button" onClick={() => { setTouchedUsername(true); setUsername(s); }}
                className="rounded-full border px-2 py-0.5 text-xs hover:bg-accent">{s}</button>
            ))}
          </div>
        )}
      </div>
      <div className="grid gap-1.5"><Label htmlFor="password">Password</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={8} required />
        <p className="text-xs text-muted-foreground">At least 8 characters.</p></div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" loading={loading}>Create account</Button>
    </form>
  );
}
