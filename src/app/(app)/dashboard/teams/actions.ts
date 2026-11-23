"use server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth-session";
import { runAction, type ActionResult } from "@/lib/validation/action-result";
import { AppError } from "@/server/errors";
import {
  changeMemberRole, checkOrgSlug, createOrganization, inviteMember, leaveOrganization, removeMember, resendInvitation,
  revokeInvitation, setMemberPermissions, transferOwnership, updateOrganization,
} from "@/server/services/organizations";
import { reactivateMember, setMemberManager } from "@/server/services/bench";

const uuid = z.string().uuid();
const role = z.enum(["owner", "admin", "member"]);
function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new AppError("VALIDATION", r.error.issues[0]?.message ?? "Invalid input", 422);
  return r.data;
}
const refresh = (orgId?: string) => {
  revalidatePath("/dashboard/teams");
  if (orgId) revalidatePath(`/dashboard/teams/${orgId}`);
};

export async function createOrganizationAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireUser();
  return runAction(async () => {
    const v = parse(z.object({ name: z.string(), slug: z.string().optional(), brandColor: z.string().nullish(), logoUrl: z.string().nullish() }), input);
    const org = await createOrganization(user.id, v);
    refresh();
    revalidatePath("/dashboard/event-types");
    return { id: org.id };
  });
}

export async function checkOrgSlugAction(slug: string, orgId?: string): Promise<{ available: boolean; message?: string }> {
  await requireUser();
  return checkOrgSlug(String(slug ?? "").slice(0, 60), orgId && uuid.safeParse(orgId).success ? orgId : undefined);
}

export async function updateOrganizationAction(orgId: string, input: unknown): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(async () => {
    const v = parse(z.object({ name: z.string().optional(), slug: z.string().optional(), brandColor: z.string().nullish(), logoUrl: z.string().nullish() }), input);
    await updateOrganization(user.id, parse(uuid, orgId), v);
    refresh(orgId);
    return null;
  });
}

export async function inviteMemberAction(orgId: string, input: unknown): Promise<ActionResult<{ inviteUrl: string; emailSent: boolean }>> {
  const user = await requireUser();
  return runAction(async () => {
    const v = parse(z.object({ email: z.string(), role: role.optional() }), input);
    const r = await inviteMember(user.id, parse(uuid, orgId), v);
    refresh(orgId);
    return { inviteUrl: r.inviteUrl, emailSent: r.emailSent };
  });
}

export async function resendInvitationAction(orgId: string, invitationId: string): Promise<ActionResult<{ inviteUrl: string; emailSent: boolean }>> {
  const user = await requireUser();
  return runAction(async () => {
    const r = await resendInvitation(user.id, parse(uuid, orgId), parse(uuid, invitationId));
    refresh(orgId);
    return r;
  });
}

export async function revokeInvitationAction(orgId: string, invitationId: string): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(async () => {
    await revokeInvitation(user.id, parse(uuid, orgId), parse(uuid, invitationId));
    refresh(orgId);
    return null;
  });
}

export async function changeRoleAction(orgId: string, userId: string, newRole: string): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(async () => {
    await changeMemberRole(user.id, parse(uuid, orgId), parse(z.string().min(1), userId), parse(role, newRole));
    refresh(orgId);
    return null;
  });
}

export async function setPermissionsAction(orgId: string, userId: string, permissions: string[]): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(async () => {
    await setMemberPermissions(user.id, parse(uuid, orgId), parse(z.string().min(1), userId), parse(z.array(z.string()).max(20), permissions));
    refresh(orgId);
    return null;
  });
}

export async function reactivateMemberAction(orgId: string, userId: string): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(async () => {
    await reactivateMember(user.id, parse(uuid, orgId), parse(z.string().min(1), userId));
    refresh(orgId);
    return null;
  });
}

export async function setManagerAction(orgId: string, userId: string, managerUserId: string | null): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(async () => {
    await setMemberManager(user.id, parse(uuid, orgId), parse(z.string().min(1), userId), parse(z.string().min(1).nullable(), managerUserId));
    refresh(orgId);
    return null;
  });
}

export async function removeMemberAction(orgId: string, userId: string): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(async () => {
    await removeMember(user.id, parse(uuid, orgId), parse(z.string().min(1), userId));
    refresh(orgId);
    return null;
  });
}

export async function leaveOrganizationAction(orgId: string): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(async () => {
    await leaveOrganization(user.id, parse(uuid, orgId));
    refresh();
    return null;
  });
}

export async function transferOwnershipAction(orgId: string, toUserId: string): Promise<ActionResult> {
  const user = await requireUser();
  return runAction(async () => {
    await transferOwnership(user.id, parse(uuid, orgId), parse(z.string().min(1), toUserId));
    refresh(orgId);
    return null;
  });
}
