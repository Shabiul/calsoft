"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MoreHorizontal } from "lucide-react";
import {
  Avatar, Badge, Button, Card, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, toast,
} from "@/components/ui";
import {
  changeRoleAction, leaveOrganizationAction, reactivateMemberAction, removeMemberAction, setManagerAction, setPermissionsAction, transferOwnershipAction,
} from "@/app/(app)/dashboard/teams/actions";

import { ROLE_RANK as RANK, ROLE_LABELS, isOrgAdmin, type OrgRole as Role } from "@/lib/org-roles";
export type MemberView = {
  userId: string; name: string; email: string; image: string | null; role: Role; permissions: string[]; joinedAt: string;
  status: string; lastActiveAt: string; managerUserId: string | null;
};

/** Mirrors BENCH_RULES in server/services/bench.ts. */
const WARN_DAYS = 14;
const idleDays = (iso: string) => Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);

/** Mirrors ORG_PERMISSIONS in the service (kept inline so this client bundle does not import server code). */
const PERMISSIONS = [
  { key: "members.invite", label: "Invite members" },
  { key: "bookings.view_all", label: "View all team bookings" },
  { key: "branding.manage", label: "Edit organization branding" },
  { key: "event_types.manage", label: "Manage team event types" },
];

export function MembersPanel({ orgId, currentUserId, actorRole, members }: { orgId: string; currentUserId: string; actorRole: Role; members: MemberView[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [permFor, setPermFor] = useState<MemberView | null>(null);
  const [perms, setPerms] = useState<string[]>([]);

  const run = (fn: () => Promise<{ ok: boolean; error?: { message: string } }>, ok: string, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (!r.ok) { toast.error(r.error?.message ?? "Something went wrong"); return; }
      toast.success(ok); after?.(); router.refresh();
    });

  const remove = (m: MemberView) => {
    if (!window.confirm(`Remove ${m.name} from this team? They will be taken off all team event types.`)) return;
    run(() => removeMemberAction(orgId, m.userId), "Member removed");
  };
  const leave = () => {
    if (!window.confirm("Leave this team?")) return;
    run(() => leaveOrganizationAction(orgId), "You left the team", () => router.push("/dashboard/teams"));
  };
  const transfer = (m: MemberView) => {
    if (!window.confirm(`Make ${m.name} the owner? You will become an admin.`)) return;
    run(() => transferOwnershipAction(orgId, m.userId), "Ownership transferred");
  };

  return (
    <section aria-labelledby="members-h" className="space-y-3">
      <h2 id="members-h" className="text-base font-semibold">Members ({members.length})</h2>
      <Card className="divide-y">
        {members.map((m) => {
          const me = m.userId === currentUserId;
          const canRemove = !me && isOrgAdmin(actorRole) && (actorRole === "owner" || RANK[m.role] < RANK[actorRole]);
          const canPerms = isOrgAdmin(actorRole) && RANK[m.role] < RANK.admin;
          const isAdmin = isOrgAdmin(actorRole);
          const canReactivate = !me && (isAdmin || m.managerUserId === currentUserId);
          const benched = m.status === "benched";
          const idle = idleDays(m.lastActiveAt);
          const manager = members.find((x) => x.userId === m.managerUserId);
          return (
            <div key={m.userId} className="flex flex-wrap items-center gap-3 p-4">
              <Avatar src={m.image} name={m.name} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 truncate font-medium">{m.name}{me && <span className="text-xs font-normal text-muted-foreground">(you)</span>}</div>
                <div className="truncate text-xs text-muted-foreground">{m.email}</div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {benched && <Badge variant="destructive">Benched, meetings moved to manager</Badge>}
                  {!benched && idle >= WARN_DAYS && <Badge variant="warning">Inactive {idle} days</Badge>}
                  {isAdmin && !me ? (
                    <label className="flex items-center gap-1">Reports to
                      <select aria-label={`Reports to, for ${m.name}`} value={m.managerUserId ?? ""} disabled={pending}
                        className="h-7 rounded-md border border-input bg-card px-1 text-xs"
                        onChange={(e) => run(() => setManagerAction(orgId, m.userId, e.target.value || null), "Manager updated")}>
                        <option value="">Team owners &amp; admins</option>
                        {members.filter((x) => x.userId !== m.userId).map((x) => <option key={x.userId} value={x.userId}>{x.name}</option>)}
                      </select>
                    </label>
                  ) : manager && <span>Manager: {manager.name}</span>}
                </div>
                {RANK[m.role] < RANK.admin && m.permissions.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">{m.permissions.map((p) => <Badge key={p} variant="outline" className="text-[10px]">{PERMISSIONS.find((x) => x.key === p)?.label ?? p}</Badge>)}</div>
                )}
              </div>
              {isOrgAdmin(actorRole) && !me && (actorRole === "owner" || RANK[m.role] < RANK.admin) ? (
                <select aria-label={`Role for ${m.name}`} value={m.role} disabled={pending}
                  className="h-8 rounded-md border border-input bg-card px-2 text-sm"
                  onChange={(e) => run(() => changeRoleAction(orgId, m.userId, e.target.value), "Role updated")}>
                  {/* Owners can set any role; admins can set manager / team lead / member (the server enforces this too). */}
                  {(actorRole === "owner" ? (["owner", "admin", "manager", "team_lead", "member"] as const) : (["manager", "team_lead", "member"] as const))
                    .map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </select>
              ) : <Badge variant={m.role === "owner" ? "default" : "secondary"}>{ROLE_LABELS[m.role]}</Badge>}
              <DropdownMenu>
                <DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={`Actions for ${m.name}`}><MoreHorizontal /></Button></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  {canReactivate && (benched || idle >= WARN_DAYS) && (
                    <DropdownMenuItem onSelect={() => run(() => reactivateMemberAction(orgId, m.userId), benched ? `${m.name} restored` : `${m.name} marked as active`)}>
                      {benched ? "Restore (un-bench)" : "Mark as active"}
                    </DropdownMenuItem>
                  )}
                  {canPerms && <DropdownMenuItem onSelect={() => { setPermFor(m); setPerms(m.permissions); }}>Edit permissions</DropdownMenuItem>}
                  {actorRole === "owner" && !me && <DropdownMenuItem onSelect={() => transfer(m)}>Transfer ownership</DropdownMenuItem>}
                  {(canPerms || (actorRole === "owner" && !me)) && (canRemove || me) && <DropdownMenuSeparator />}
                  {me && <DropdownMenuItem onSelect={leave} className="text-destructive">Leave team</DropdownMenuItem>}
                  {canRemove && <DropdownMenuItem onSelect={() => remove(m)} className="text-destructive">Remove from team</DropdownMenuItem>}
                  {!canPerms && !canRemove && !me && !(actorRole === "owner") && !(canReactivate && (benched || idle >= WARN_DAYS)) && <DropdownMenuItem disabled>No actions available</DropdownMenuItem>}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          );
        })}
      </Card>

      <Dialog open={!!permFor} onOpenChange={(o) => { if (!o) setPermFor(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Permissions for {permFor?.name}</DialogTitle>
            <DialogDescription>Admins and owners always have every permission. Grant extra abilities to this member.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {PERMISSIONS.map((p) => (
              <label key={p.key} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={perms.includes(p.key)} onChange={(e) => setPerms(e.target.checked ? [...perms, p.key] : perms.filter((x) => x !== p.key))} />
                {p.label}
              </label>
            ))}
          </div>
          <Button loading={pending} onClick={() => permFor && run(() => setPermissionsAction(orgId, permFor.userId, perms), "Permissions saved", () => setPermFor(null))}>Save permissions</Button>
        </DialogContent>
      </Dialog>
    </section>
  );
}
