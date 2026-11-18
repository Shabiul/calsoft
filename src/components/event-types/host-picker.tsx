"use client";
import * as React from "react";
import { Avatar, Badge, Checkbox, Input, Label, Switch } from "@/components/ui";
import type { EventKind } from "@/lib/validation/event-types";

export type OrgMember = { userId: string; name: string; email: string; role: string };
export type HostState = { userId: string; priority: number; weight: number; isRequired: boolean };

export function HostPicker({ members, hosts, onChange, kind, error }: {
  members: OrgMember[]; hosts: HostState[]; onChange: (h: HostState[]) => void; kind: EventKind; error?: string;
}) {
  const selected = new Map(hosts.map((h) => [h.userId, h]));
  const toggle = (m: OrgMember, on: boolean) =>
    onChange(on ? [...hosts, { userId: m.userId, priority: hosts.length, weight: 1, isRequired: true }] : hosts.filter((h) => h.userId !== m.userId));
  const patch = (userId: string, p: Partial<HostState>) => onChange(hosts.map((h) => (h.userId === userId ? { ...h, ...p } : h)));

  if (members.length === 0) return <p className="text-sm text-muted-foreground">This organization has no members to choose from yet.</p>;

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {kind === "collective" ? "All required hosts must be free for a slot to be offered." : kind === "round_robin" ? "Bookings are distributed using priority (lower first) and weight." : "Choose who hosts this event."}
      </p>
      <ul className="divide-y rounded-lg border">
        {members.map((m) => {
          const h = selected.get(m.userId);
          return (
            <li key={m.userId} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
              <Checkbox id={`host-${m.userId}`} checked={!!h} onCheckedChange={(c) => toggle(m, c === true)} aria-label={`Host ${m.name}`} />
              <Label htmlFor={`host-${m.userId}`} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                <Avatar name={m.name} className="size-7" />
                <span className="min-w-0"><span className="block truncate">{m.name}</span><span className="block truncate text-xs font-normal text-muted-foreground">{m.email}</span></span>
                <Badge variant="secondary">{m.role}</Badge>
              </Label>
              {h && kind === "round_robin" ? (
                <div className="flex items-center gap-2 text-xs">
                  <label className="flex items-center gap-1">Priority
                    <Input className="h-8 w-16" type="number" min={0} value={h.priority} onChange={(e) => patch(m.userId, { priority: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
                  </label>
                  <label className="flex items-center gap-1">Weight
                    <Input className="h-8 w-16" type="number" min={1} value={h.weight} onChange={(e) => patch(m.userId, { weight: Math.max(1, Math.floor(Number(e.target.value) || 1)) })} />
                  </label>
                </div>
              ) : null}
              {h && kind === "collective" ? (
                <label className="flex items-center gap-2 text-xs"><Switch checked={h.isRequired} onCheckedChange={(c) => patch(m.userId, { isRequired: c })} aria-label={`${m.name} required`} /> Required</label>
              ) : null}
            </li>
          );
        })}
      </ul>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
