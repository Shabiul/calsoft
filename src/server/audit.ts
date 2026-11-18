import { db } from "@/server/db";
import { auditLogs } from "@/server/db/schema";

export type AuditActor = string | null | { id?: string | null; organizationId?: string | null; ip?: string | null };
export type AuditEntity = string | { type: string; id?: string | null } | null;

/** Append an audit_log row. Never throws (auditing must not break the primary operation). */
export async function audit(actor: AuditActor, action: string, entity?: AuditEntity, meta?: Record<string, unknown>): Promise<void> {
  const a = typeof actor === "string" || actor === null ? { id: actor } : actor;
  const e = typeof entity === "string" ? { type: entity, id: null } : entity;
  try {
    await db.insert(auditLogs).values({
      actorId: a.id ?? null, organizationId: "organizationId" in a ? (a.organizationId ?? null) : null, action,
      entity: e?.type ?? null, entityId: e?.id ?? null, meta: meta ?? null, ip: "ip" in a ? (a.ip ?? null) : null,
    });
  } catch (err) {
    console.error("[audit] failed", action, err instanceof Error ? err.message : err);
  }
}
