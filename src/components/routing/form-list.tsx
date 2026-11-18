"use client";
import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { Badge, Button, Card, Input, Label } from "@/components/ui";
import { createFormAction, deleteFormAction } from "@/app/(app)/dashboard/routing-forms/actions";

export interface FormRow { id: string; name: string; slug: string; fields: number; rules: number; submissions: number }

export function NewFormButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  if (!open) return <Button onClick={() => setOpen(true)}>New routing form</Button>;
  return (
    <form
      className="flex items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const r = await createFormAction(name);
          if (!r.ok) toast.error(r.error.message); else router.push(`/dashboard/routing-forms/${r.data.id}`);
        });
      }}
    >
      <div className="space-y-1.5"><Label htmlFor="nf-name" className="sr-only">Form name</Label><Input id="nf-name" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Form name" maxLength={120} required /></div>
      <Button type="submit" loading={pending}>Create</Button>
      <Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
    </form>
  );
}

export function FormList({ rows, username, origin }: { rows: FormRow[]; username: string | null; origin: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const remove = (r: FormRow) => {
    if (!window.confirm(`Delete "${r.name}" and its ${r.submissions} submission(s)?`)) return;
    start(async () => {
      const res = await deleteFormAction(r.id);
      if (!res.ok) toast.error(res.error.message); else { toast.success("Form deleted"); router.refresh(); }
    });
  };
  return (
    <div className="space-y-3">
      {!username && <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">Set a username in Settings to get a public link for your forms.</p>}
      {rows.map((r) => {
        const path = username ? `/r/${username}/${r.slug}` : null;
        return (
          <Card key={r.id} className="flex flex-wrap items-center gap-4 p-4">
            <div className="min-w-0 flex-1">
              <Link href={`/dashboard/routing-forms/${r.id}`} className="font-medium hover:underline">{r.name}</Link>
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Badge variant="secondary">{r.fields} field{r.fields === 1 ? "" : "s"}</Badge>
                <Badge variant="secondary">{r.rules} rule{r.rules === 1 ? "" : "s"}</Badge>
                <Link href={`/dashboard/routing-forms/${r.id}/submissions`} className="hover:underline">{r.submissions} submission{r.submissions === 1 ? "" : "s"}</Link>
                {path && <span className="truncate">{path}</span>}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {path && (
                <Button variant="outline" size="sm" onClick={async () => {
                  try { await navigator.clipboard.writeText(`${origin || window.location.origin}${path}`); toast.success("Link copied"); } catch { toast.error("Could not copy"); }
                }}><Copy /> Copy link</Button>
              )}
              <Button asChild variant="outline" size="sm"><Link href={`/dashboard/routing-forms/${r.id}`}>Edit</Link></Button>
              <Button variant="ghost" size="sm" disabled={pending} onClick={() => remove(r)}>Delete</Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
