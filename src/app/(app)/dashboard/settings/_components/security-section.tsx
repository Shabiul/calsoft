"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authClient } from "@/lib/auth-client";

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

/** Sign-in is Zoho only: passwords and multi-factor authentication are managed in the company's Zoho account. */
export function SecuritySection({ email, providers }: { email: string; providers: string[] }) {
  return (
    <div className="grid gap-6 lg:max-w-2xl">
      <Card>
        <CardHeader><CardTitle>Sign-in methods</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">{email}</span>
          {providers.map((p) => <Badge key={p} variant="secondary" className="capitalize">{p}</Badge>)}
          <p className="w-full text-xs text-muted-foreground">You sign in with your company Zoho account. Change your password or set up multi-factor authentication in Zoho.</p>
        </CardContent>
      </Card>
      <SessionsCard />
    </div>
  );
}
