import { Suspense } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PublicShell } from "@/components/booking/PublicShell";
import { FlowSkeleton, PageFrame } from "@/components/booking/PublicChrome";
import { PublicRoutingForm } from "@/components/routing/PublicRoutingForm";
import { loadPublicForm } from "@/server/services/routing-forms";
import { APP_NAME } from "@/lib/brand";

type P = { params: Promise<{ username: string; slug: string }> };

export async function generateMetadata({ params }: P): Promise<Metadata> {
  const { username, slug } = await params;
  const f = await loadPublicForm(username, slug);
  if (!f) return { title: `Not found | ${APP_NAME}`, robots: { index: false } };
  return { title: `${f.name} | ${f.hostName}`, robots: { index: false } };
}

export default function RoutingPage({ params }: P) {
  return (
    <Suspense fallback={<PublicShell><PageFrame><FlowSkeleton /></PageFrame></PublicShell>}>
      <Form params={params} />
    </Suspense>
  );
}

async function Form({ params }: P) {
  const { username, slug } = await params;
  const form = await loadPublicForm(username, slug);
  if (!form) notFound();
  return (
    <PublicShell>
      <PageFrame>
        <PublicRoutingForm username={username.toLowerCase()} slug={slug.toLowerCase()} title={form.name} hostName={form.hostName} fields={form.fields} />
      </PageFrame>
    </PublicShell>
  );
}
