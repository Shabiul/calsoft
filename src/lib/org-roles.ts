/**
 * Organization roles, shared by server and client code (no imports): owner > admin > manager > team_lead > member.
 * `isOrgAdmin` (admin or owner) is the right test for management rights. NEVER use `role !== "member"` for that:
 * managers and team leads are not members, but they are not admins either.
 */
export const ORG_ROLES = ["owner", "admin", "manager", "team_lead", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const ROLE_RANK: Record<OrgRole, number> = { member: 1, team_lead: 2, manager: 3, admin: 4, owner: 5 };
export const ROLE_LABELS: Record<OrgRole, string> = { owner: "Owner", admin: "Admin", manager: "Manager", team_lead: "Team lead", member: "Member" };

export const isOrgAdmin = (role: OrgRole) => ROLE_RANK[role] >= ROLE_RANK.admin;

/** Roles that can view the organization's sign-ins, meetings and schedules (read-only). */
export const OVERSIGHT_ROLES: readonly OrgRole[] = ["owner", "admin", "manager", "team_lead"];
export const canOversee = (role: OrgRole) => OVERSIGHT_ROLES.includes(role);
export const roleLabel = (role: string) => ROLE_LABELS[role as OrgRole] ?? role;
export const isOrgRole = (v: unknown): v is OrgRole => typeof v === "string" && (ORG_ROLES as readonly string[]).includes(v);
