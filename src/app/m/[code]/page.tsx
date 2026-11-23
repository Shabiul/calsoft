import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadEventByShortCode, trackPageView } from "@/server/public/data";
import { PublicShell } from "@/components/booking/PublicShell";
import { PageFrame, FlowSkeleton } from "@/components/booking/PublicChrome";
import { BookingFlow } from "@/components/booking/BookingFlow";
import { contextToken } from "@/server/public/schemas";
import { formatDuration } from "@/components/booking/format";
import { APP_NAME } from "@/lib/brand";

/**
 * Locked share link: /m/<code>. Shows only this one event's scheduling flow. The URL carries no username or event slug
 * (nothing to trim into the host's profile) and the page has no link back to the host's profile or other event types.
 */
type P = { params: Promise<{ code: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const { code } = await params;
  const e = await loadEventByShortCode(code);
  if (!e) return { title: `Not found | ${APP_NAME}`, robots: { index: false } };
  const title = `${e.title} with ${e.host.name}`;
  const description = (e.description?.replace(/\s+/g, " ").slice(0, 160)) || `Book a ${formatDuration(e.durationMinutes)} meeting with ${e.host.name}.`;
  return {
    title, description, robots: { index: false, follow: false },
    openGraph: { title, description, type: "website", images: e.host.image ? [{ url: e.host.image }] : undefined },
    twitter: { card: "summary", title, description },
  };
}

export default function ShortEventPage({ params, searchParams }: P) {
  return (
    <Suspense fallback={<PublicShell><PageFrame wide><FlowSkeleton /></PageFrame></PublicShell>}>
      <Event params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Event({ params, searchParams }: P) {
  const { code } = await params;
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.slice(0, 200);
  const prefill = { name: one(sp.name), email: one(sp.email) };
  const event = await loadEventByShortCode(code);
  if (!event) notFound();
  await trackPageView(event.id, null);
  return (
    <PublicShell brandColor={event.brandColor}>
      <PageFrame wide>
        <BookingFlow event={event} prefill={prefill} contextToken={contextToken(sp.ctx)} />
      </PageFrame>
    </PublicShell>
  );
}
