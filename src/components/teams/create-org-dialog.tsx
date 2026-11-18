"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger, Input, Label } from "@/components/ui";
import { createOrganizationAction, checkOrgSlugAction } from "@/app/(app)/dashboard/teams/actions";

const slugify = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);

export function CreateOrgDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [touched, setTouched] = useState(false);
  const [slugMsg, setSlugMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const checkSlug = async (s: string) => {
    if (s.length < 3) { setSlugMsg(null); return; }
    const r = await checkOrgSlugAction(s);
    setSlugMsg(r.available ? null : (r.message ?? "Not available"));
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    start(async () => {
      const r = await createOrganizationAction({ name, slug: slug || undefined });
      if (!r.ok) { setError(r.error.message); return; }
      setOpen(false);
      router.push(`/dashboard/teams/${r.data.id}`);
      router.refresh();
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button><Plus /> New team</Button></DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create a team</DialogTitle>
          <DialogDescription>Your team gets a public page where its shared event types can be booked.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="org-name">Team name</Label>
            <Input id="org-name" required minLength={2} maxLength={80} value={name} autoFocus
              onChange={(e) => { setName(e.target.value); if (!touched) setSlug(slugify(e.target.value)); }}
              onBlur={() => checkSlug(slug)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="org-slug">Team URL</Label>
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <span>/</span>
              <Input id="org-slug" required minLength={3} maxLength={30} value={slug} aria-invalid={!!slugMsg}
                onChange={(e) => { setTouched(true); setSlug(e.target.value.toLowerCase()); setSlugMsg(null); }}
                onBlur={() => checkSlug(slug)} />
            </div>
            {slugMsg ? <p className="text-xs text-destructive" role="alert">{slugMsg}</p> : <p className="text-xs text-muted-foreground">Shares its namespace with usernames.</p>}
          </div>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          <Button type="submit" loading={pending} disabled={!!slugMsg}>Create team</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
