import { listOrgMembers, listUserOrganizations } from "@/server/services/event-types";
import { listSchedules } from "@/server/services/availability";
import type { OrgMember } from "@/components/event-types/host-picker";

/** Reference data needed by the event type form (server only). */
export async function loadFormRefs(userId: string, opts: { onlyOrgId?: string | null } = {}) {
  const orgs = (await listUserOrganizations({ userId })).filter((o) => o.role === "owner" || o.role === "admin");
  const scoped = opts.onlyOrgId ? orgs.filter((o) => o.id === opts.onlyOrgId) : orgs;
  const membersByOrg: Record<string, OrgMember[]> = {};
  await Promise.all(scoped.map(async (o) => { membersByOrg[o.id] = await listOrgMembers({ userId }, o.id); }));
  const schedules = (await listSchedules(userId)).map((s) => ({ id: s.id, name: s.name, isDefault: s.isDefault }));
  return { organizations: scoped.map((o) => ({ id: o.id, name: o.name })), membersByOrg, schedules };
}
