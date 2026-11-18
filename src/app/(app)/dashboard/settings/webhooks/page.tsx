import { Suspense } from "react";
import { PageHeader, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { listWebhookEndpoints } from "@/server/webhooks/endpoints";
import { WebhooksPanel } from "./webhooks-panel";

export const metadata = { title: "Webhooks" };

export default function WebhooksPage() {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader title="Webhooks" description="Receive signed HTTP callbacks when bookings change." />
      <Suspense fallback={<Skeleton className="h-60" />}><Content /></Suspense>
    </div>
  );
}
async function Content() {
  const user = await requireUser();
  const endpoints = await listWebhookEndpoints(user.id);
  return <WebhooksPanel endpoints={endpoints.map((e) => ({ id: e.id, url: e.url, events: e.events, isActive: e.isActive, createdAt: e.createdAt.toISOString() }))} />;
}
