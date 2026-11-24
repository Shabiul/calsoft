import { describe, expect, it } from "vitest";
import { canOversee, isOrgAdmin, isOrgRole, ORG_ROLES, ROLE_RANK, roleLabel } from "./org-roles";

describe("org roles", () => {
  it("rank order is owner > admin > manager > team_lead > member", () => {
    expect([...ORG_ROLES].sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])).toEqual(["owner", "admin", "manager", "team_lead", "member"]);
  });
  it("only owners and admins have management rights: managers and team leads do not", () => {
    expect(ORG_ROLES.filter(isOrgAdmin)).toEqual(["owner", "admin"]);
  });
  it("owners, admins, managers and team leads can oversee; plain members cannot", () => {
    expect(ORG_ROLES.filter(canOversee).sort()).toEqual(["admin", "manager", "owner", "team_lead"]);
    expect(canOversee("member")).toBe(false);
  });
  it("labels and validation", () => {
    expect(roleLabel("team_lead")).toBe("Team lead");
    expect(roleLabel("weird")).toBe("weird");
    expect(isOrgRole("manager")).toBe(true);
    expect(isOrgRole("root")).toBe(false);
  });
});
