import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadEvent, trackPageView, loadUserIdByUsername } from "@/server/public/data";
import { PublicShell } from "@/components/booking/PublicShell";
import { PageFrame, FlowSkeleton } from "@/components/booking/PublicChrome";
import { BookingFlow } from "@/components/booking/BookingFlow";
import { formatDuration } from "@/components/booking/format";
import { APP_NAME } from "@/lib/brand";

type P = { params: Promise<{ username: string; eventSlug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const { username, eventSlug } = await params;
  const e = await loadEvent(username, eventSlug);
  if (!e) return { title: `Not found | ${APP_NAME}`, robots: { index: false } };
  const title = `${e.title} with ${e.host.name}`;
  const description = (e.description?.replace(/\s+/g, " ").slice(0, 160)) || `Book a ${formatDuration(e.durationMinutes)} meeting with ${e.host.name}.`;
  return {
    title, description,
    openGraph: { title, description, type: "website", images: e.host.image ? [{ url: e.host.image }] : undefined },
    twitter: { card: "summary", title, description },
  };
}

export default function EventPage({ params, searchParams }: P) {
  return (
    <Suspense fallback={<PublicShell><PageFrame wide><FlowSkeleton /></PageFrame></PublicShell>}>
      <Event params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Event({ params, searchParams }: P) {
  const { username, eventSlug } = await params;
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.slice(0, 200);
  const prefill = { name: one(sp.name), email: one(sp.email) }; // routing-form redirects; rendered via React so escaped
  const event = await loadEvent(username, eventSlug);
  if (!event) notFound();
  const uid = await loadUserIdByUsername(username);
  await trackPageView(event.id, uid);
  return (
    <PublicShell brandColor={event.brandColor}>
      <PageFrame wide>
        <div style={{ marginBottom: 12 }}>
          <a href={`/${event.host.username}`} className="mf-muted" style={{ fontSize: 14, textDecoration: "none" }}>&larr; {event.host.name}</a>
        </div>
        <BookingFlow event={event} prefill={prefill} />
      </PageFrame>
    </PublicShell>
  );
}
