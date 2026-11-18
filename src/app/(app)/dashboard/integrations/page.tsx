import { Suspense } from "react";
import { requireUser } from "@/lib/auth-session";
import { PageHeader, Skeleton } from "@/components/ui";
import { listConnections } from "@/server/integrations/connections";
import { canReceiveWebhooks, isConfigured, missingEnv, redirectUri, webhookUrl } from "@/server/integrations/config";
import { IntegrationsPanel, type ProviderInfo } from "./integrations-panel";

export const metadata = { title: "Integrations" };


const MESSAGES: Record<string, string> = {
  access_denied: "Authorization was cancelled. Nothing was connected.",
  oauth_failed: "The provider returned an error while connecting. Try again.",
  invalid_state: "The connection attempt expired or was invalid. Please start again.",
  google_not_configured: "Google credentials are not configured on this server.",
  microsoft_not_configured: "Microsoft credentials are not configured on this server.",
  zoom_not_configured: "Zoom credentials are not configured on this server.",
};

async function Content({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  const [user, sp] = await Promise.all([requireUser(), searchParams]);
  const data = await listConnections(user.id);
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  const providers: ProviderInfo[] = (["google", "microsoft", "zoom"] as const).map((id) => ({
    id, configured: isConfigured(id), missing: missingEnv(id), redirectUri: redirectUri(id),
    webhookUrl: id === "zoom" ? null : webhookUrl(id),
  }));
  const error = first(sp.error); const connected = first(sp.connected);
  return (
    <IntegrationsPanel
      providers={providers}
      webhooksAvailable={canReceiveWebhooks()}
      flash={error ? { type: "error", text: MESSAGES[error] ?? "Something went wrong." } : connected ? { type: "success", text: `${connected} connected.` } : null}
      connections={data.connections.map((c) => ({
        ...c, createdAt: c.createdAt.toISOString(),
        calendars: c.calendars.map((k) => ({ ...k, lastSyncedAt: k.lastSyncedAt?.toISOString() ?? null })),
      }))}
      video={data.video}
    />
  );
}

export default function IntegrationsPage({ searchParams }: { searchParams: Promise<{ [k: string]: string | string[] | undefined }> }) {
  return (
    <div>
      <PageHeader title="Integrations" description="Connect calendars to avoid double-booking and add events and meeting links to new bookings." />
      <Suspense fallback={<div className="space-y-4"><Skeleton className="h-40 w-full" /><Skeleton className="h-40 w-full" /></div>}>
        <Content searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
