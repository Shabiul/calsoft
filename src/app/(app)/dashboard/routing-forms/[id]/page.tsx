import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { isAppError } from "@/server/errors";
import { getForm, listRoutableEventTypes } from "@/server/services/routing-forms";
import { FormBuilder } from "@/components/routing/form-builder";

export const metadata = { title: "Edit routing form" };

export default function EditRoutingFormPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <Link href="/dashboard/routing-forms" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Routing forms</Link>
      <Suspense fallback={<div className="space-y-3"><Skeleton className="h-28" /><Skeleton className="h-64" /></div>}>
        <Content params={params} />
      </Suspense>
    </div>
  );
}

async function Content({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  let form;
  try { form = await getForm(user.id, id); } catch (e) { if (isAppError(e) && e.status === 404) notFound(); throw e; }
  const events = await listRoutableEventTypes(user.id);
  return (
    <FormBuilder
      key={form.id}
      formId={form.id}
      initial={{ name: form.name, slug: form.slug, config: form.config }}
      events={events.map((e) => ({ id: e.id, title: e.title }))}
      username={user.username}
      origin={process.env.APP_URL?.replace(/\/$/, "") ?? ""}
    />
  );
}
