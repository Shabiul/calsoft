import { Suspense } from "react";
import { GitBranch } from "lucide-react";
import { EmptyState, PageHeader, Skeleton } from "@/components/ui";
import { requireUser } from "@/lib/auth-session";
import { listForms } from "@/server/services/routing-forms";
import { FormList, NewFormButton } from "@/components/routing/form-list";

export const metadata = { title: "Routing forms" };

export default function RoutingFormsPage() {
  return (
    <div className="mx-auto w-full max-w-4xl">
      <PageHeader title="Routing forms" description="Ask a few questions, then send each visitor to the right booking page." actions={<NewFormButton />} />
      <Suspense fallback={<div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-20" /></div>}>
        <Content />
      </Suspense>
    </div>
  );
}

async function Content() {
  const user = await requireUser();
  const forms = await listForms(user.id);
  if (!forms.length) {
    return <EmptyState icon={<GitBranch />} title="No routing forms yet" description="Create a form with conditional questions and rules that redirect people to the right event type, a URL or a message." action={<NewFormButton />} />;
  }
  return (
    <FormList
      username={user.username}
      origin={process.env.APP_URL?.replace(/\/$/, "") ?? ""}
      rows={forms.map((f) => ({ id: f.id, name: f.name, slug: f.slug, fields: f.config.fields.length, rules: f.config.rules.length, submissions: f.submissionCount ?? 0 }))}
    />
  );
}
