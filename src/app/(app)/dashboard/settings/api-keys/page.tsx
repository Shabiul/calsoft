import { Suspense } from "react";
import { PageHeader, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { listApiKeys } from "@/server/api-keys";
import { ApiKeysPanel } from "./api-keys-panel";

export const metadata = { title: "API keys" };

export default function ApiKeysPage() {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader title="API keys" description="Authenticate scripts and integrations with the MeetFlow API." />
      <Suspense fallback={<Skeleton className="h-60" />}><Content /></Suspense>
    </div>
  );
}
async function Content() {
  const user = await requireUser();
  const keys = await listApiKeys(user.id);
  return (
    <ApiKeysPanel keys={keys.map((k) => ({
      id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes,
      lastUsedAt: k.lastUsedAt?.toISOString() ?? null, revokedAt: k.revokedAt?.toISOString() ?? null, createdAt: k.createdAt.toISOString(),
    }))} />
  );
}
