import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { Badge, Button, PageHeader, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { isAppError } from "@/server/errors";
import { getEventType, publicPathFor } from "@/server/services/event-types";
import { EventTypeForm } from "@/components/event-types/event-type-form";
import { stateFromEventType } from "@/components/event-types/event-type-state";
import { loadFormRefs } from "../_data";

export const metadata = { title: "Edit event type" };

export default function EditEventTypePage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <div className="mx-auto w-full max-w-3xl">
      <Link href="/dashboard/event-types" className="mb-3 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> Event types</Link>
      <Suspense fallback={<div className="space-y-4"><Skeleton className="h-10 w-80" /><Skeleton className="h-96" /></div>}>
        <Content params={params} />
      </Suspense>
    </div>
  );
}

async function Content({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  let et;
  try {
    et = await getEventType({ userId: user.id }, id);
  } catch (e) {
    if (isAppError(e) && (e.status === 404 || e.status === 403)) notFound();
    throw e;
  }
  const [refs, path] = await Promise.all([loadFormRefs(user.id, { onlyOrgId: et.organizationId }), publicPathFor(et)]);
  const origin = process.env.APP_URL?.replace(/\/$/, "") ?? "";
  return (
    <>
      <PageHeader
        title={et.title}
        description={path ? `${origin}${path}` : "Set a username to get a public link."}
        actions={
          <>
            {et.archivedAt ? <Badge variant="secondary">Archived</Badge> : null}
            {path ? <Button asChild variant="outline" size="sm"><a href={path} target="_blank" rel="noreferrer"><ExternalLink /> Preview</a></Button> : null}
          </>
        }
      />
      <EventTypeForm mode="edit" eventTypeId={et.id} initial={stateFromEventType(et as Parameters<typeof stateFromEventType>[0])} currentUserId={user.id} {...refs} />
    </>
  );
}
