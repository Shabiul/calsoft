import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";
import { AppError } from "@/server/errors";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  username: string | null;
  timeZone: string;
  language: string;
  dateFormat: string;
  timeFormat: string;
  platformRole: "user" | "superadmin";
  twoFactorEnabled: boolean;
}
export interface AppSession { user: SessionUser; sessionId: string }

/** Current session or null (never throws/redirects). Deduped per request. Must be called inside a Suspense boundary under Cache Components. */
export const getSession = cache(async (): Promise<AppSession | null> => {
  const s = await auth.api.getSession({ headers: await headers() });
  if (!s) return null;
  const u = s.user as Record<string, unknown>;
  if (u.deletedAt || u.status === "suspended") return null;
  return {
    sessionId: s.session.id,
    user: {
      id: s.user.id, name: s.user.name, email: s.user.email, emailVerified: s.user.emailVerified,
      image: s.user.image ?? null,
      username: (u.username as string | null) ?? null,
      timeZone: (u.timeZone as string) || "UTC",
      language: (u.language as string) || "en",
      dateFormat: (u.dateFormat as string) || "MM/dd/yyyy",
      timeFormat: (u.timeFormat as string) || "12h",
      platformRole: u.platformRole === "superadmin" ? "superadmin" : "user",
      twoFactorEnabled: Boolean(u.twoFactorEnabled),
    },
  };
});

/** For pages / server actions: redirects to /login when signed out. */
export async function requireUser(): Promise<SessionUser> {
  const s = await getSession();
  if (!s) redirect("/login");
  return s.user;
}

/** For route handlers: throws AppError 401 instead of redirecting. */
export async function requireUserApi(): Promise<SessionUser> {
  const s = await getSession();
  if (!s) throw new AppError("UNAUTHORIZED", "Authentication required", 401);
  return s.user;
}

/** Platform admin gate. Redirects to /login when signed out, throws 403 for non-superadmins. */
export async function requireSuperadmin(): Promise<SessionUser> {
  const user = await requireUser();
  if (user.platformRole !== "superadmin") throw new AppError("FORBIDDEN", "Superadmin access required", 403);
  return user;
}
