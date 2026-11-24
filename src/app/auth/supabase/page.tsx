"use client";
import { useEffect, useState } from "react";

/** Landing page for Supabase email links (magic link / confirm email): reads the token from the URL hash and exchanges it for a MeetFlow session. */
export default function SupabaseLanding() {
  const [msg, setMsg] = useState("Signing you in...");
  useEffect(() => {
    const h = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const token = h.get("access_token");
    window.history.replaceState(null, "", window.location.pathname); // never leave the token in the address bar
    if (!token) { setMsg(h.get("error_description")?.replace(/\+/g, " ") ?? "This link is invalid or has expired."); return; }
    fetch("/api/auth/supabase/exchange", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ accessToken: token }) })
      .then(async (r) => {
        if (r.ok) { window.location.replace("/dashboard"); return; }
        const j = (await r.json().catch(() => ({}))) as { message?: string };
        setMsg(j.message ?? "Could not sign you in.");
      })
      .catch(() => setMsg("Network error. Try again."));
  }, []);
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-3 p-6 text-center">
      <p role="status" className="text-sm">{msg}</p>
      <a href="/login" className="text-sm underline">Back to sign in</a>
    </main>
  );
}
