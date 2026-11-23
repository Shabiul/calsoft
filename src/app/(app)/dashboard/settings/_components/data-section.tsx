"use client";
import { useState, useTransition } from "react";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";
import { deleteAccountAction } from "../actions";

export function DataSection({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function remove() {
    setError(null);
    start(async () => {
      const r = await deleteAccountAction(confirm);
      if (!r.ok) { setError(r.error.message); return; }
      toast.success("Your account has been deleted.");
      await authClient.signOut().catch(() => undefined);
      window.location.href = "/";
    });
  }

  return (
    <div className="grid gap-6 lg:max-w-2xl">
      <Card>
        <CardHeader><CardTitle>Export your data</CardTitle><CardDescription>Download a JSON file with your profile, event types, availability, contacts and bookings.</CardDescription></CardHeader>
        <CardContent><Button asChild variant="secondary"><a href="/api/settings/export" download><Download />Download my data</a></Button></CardContent>
      </Card>
      <Card className="border-destructive/40">
        <CardHeader><CardTitle className="text-destructive">Delete account</CardTitle>
          <CardDescription>Disables sign-in, releases your username, deactivates your event types and cancels your upcoming meetings. This cannot be undone.</CardDescription></CardHeader>
        <CardContent>
          <Dialog open={open} onOpenChange={(o) => { setOpen(o); setConfirm(""); setError(null); }}>
            <DialogTrigger asChild><Button variant="destructive">Delete my account</Button></DialogTrigger>
            <DialogContent>
              <DialogHeader><DialogTitle>Delete your account?</DialogTitle>
                <DialogDescription>{`Type ${email} to confirm.`}</DialogDescription></DialogHeader>
              <div className="grid gap-1.5"><Label htmlFor="del">Email</Label>
                <Input id="del" type="text" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" /></div>
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              <DialogFooter>
                <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
                <Button variant="destructive" loading={pending} disabled={!confirm} onClick={remove}>Permanently delete</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>
    </div>
  );
}
