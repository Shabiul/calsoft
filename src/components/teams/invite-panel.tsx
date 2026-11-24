"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, Mail } from "lucide-react";
import { Badge, Button, Card, Input, Label, toast } from "@/components/ui";
import { inviteMemberAction, resendInvitationAction, revokeInvitationAction } from "@/app/(app)/dashboard/teams/actions";

import { isOrgAdmin, roleLabel, type OrgRole as Role } from "@/lib/org-roles";
export type InviteView = { id: string; email: string; role: Role; expiresAt: string; expired: boolean; invitedBy: string | null };

async function copy(text: string) {
  try { await navigator.clipboard.writeText(text); toast.success("Invite link copied"); } catch { toast.error("Copy failed; select the link and copy it manually"); }
}

export function InvitePanel({ orgId, actorRole, invites, canSeeInvites }: { orgId: string; actorRole: Role; invites: InviteView[]; canSeeInvites: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<{ url: string; emailSent: boolean } | null>(null);

  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setError(null); setLink(null);
    start(async () => {
      const r = await inviteMemberAction(orgId, { email, role });
      if (!r.ok) { setError(r.error.message); return; }
      setEmail(""); setLink({ url: r.data.inviteUrl, emailSent: r.data.emailSent });
      toast.success(r.data.emailSent ? "Invitation sent" : "Invitation created (email could not be sent)");
      router.refresh();
    });
  };
  const resend = (i: InviteView) => start(async () => {
    const r = await resendInvitationAction(orgId, i.id);
    if (!r.ok) { toast.error(r.error.message); return; }
    setLink({ url: r.data.inviteUrl, emailSent: r.data.emailSent });
    toast.success("Invitation renewed"); router.refresh();
  });
  const revoke = (i: InviteView) => {
    if (!window.confirm(`Revoke the invitation for ${i.email}?`)) return;
    start(async () => {
      const r = await revokeInvitationAction(orgId, i.id);
      if (!r.ok) toast.error(r.error.message); else { toast.success("Invitation revoked"); router.refresh(); }
    });
  };

  return (
    <section aria-labelledby="invite-h" className="space-y-3">
      <h2 id="invite-h" className="text-base font-semibold">Invite people</h2>
      <Card className="p-4">
        <form onSubmit={submit} className="flex flex-wrap items-end gap-3">
          <div className="min-w-56 flex-1 space-y-1.5">
            <Label htmlFor="invite-email">Email</Label>
            <Input id="invite-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite-role">Role</Label>
            <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Role)} className="h-9 rounded-md border border-input bg-card px-2 text-sm">
              <option value="member">Member</option>
              {isOrgAdmin(actorRole) && <option value="team_lead">Team lead</option>}
              {isOrgAdmin(actorRole) && <option value="manager">Manager</option>}
              {isOrgAdmin(actorRole) && <option value="admin">Admin</option>}
              {actorRole === "owner" && <option value="owner">Owner</option>}
            </select>
          </div>
          <Button type="submit" loading={pending}><Mail /> Send invite</Button>
        </form>
        {error && <p className="mt-2 text-sm text-destructive" role="alert">{error}</p>}
        {link && (
          <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md bg-muted p-2 text-xs">
            <span>{link.emailSent ? "Email sent. You can also share this link:" : "Email delivery failed. Share this link instead:"}</span>
            <code className="min-w-0 flex-1 break-all">{link.url}</code>
            <Button type="button" size="sm" variant="outline" onClick={() => copy(link.url)}><Copy /> Copy</Button>
          </div>
        )}
      </Card>
      {canSeeInvites && invites.length > 0 && (
        <Card className="divide-y">
          {invites.map((i) => (
            <div key={i.id} className="flex flex-wrap items-center gap-3 p-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{i.email}</div>
                <div className="text-xs text-muted-foreground">
                  {i.expired ? "Expired" : `Expires ${new Date(i.expiresAt).toLocaleDateString()}`}{i.invitedBy ? ` · invited by ${i.invitedBy}` : ""}
                </div>
              </div>
              <Badge variant={i.expired ? "warning" : "secondary"} className="capitalize">{i.expired ? "expired" : i.role}</Badge>
              <Button size="sm" variant="outline" disabled={pending} onClick={() => resend(i)}>{i.expired ? "Renew" : "Resend"}</Button>
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => revoke(i)}>Revoke</Button>
            </div>
          ))}
        </Card>
      )}
    </section>
  );
}
