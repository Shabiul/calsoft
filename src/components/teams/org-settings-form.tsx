"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Avatar, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, toast } from "@/components/ui";
import { checkOrgSlugAction, leaveOrganizationAction, updateOrganizationAction } from "@/app/(app)/dashboard/teams/actions";

type Role = "owner" | "admin" | "member";
export type OrgView = { id: string; name: string; slug: string; logoUrl: string | null; brandColor: string | null };

export function OrgSettingsForm({ org, role, canBrand, origin }: { org: OrgView; role: Role; canBrand: boolean; origin: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState(org.name);
  const [slug, setSlug] = useState(org.slug);
  const [logoUrl, setLogoUrl] = useState(org.logoUrl ?? "");
  const [color, setColor] = useState(org.brandColor ?? "#4f46e5");
  const [useColor, setUseColor] = useState(!!org.brandColor);
  const [slugMsg, setSlugMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const isAdmin = role !== "member";

  const save = (e: React.FormEvent) => {
    e.preventDefault(); setError(null);
    start(async () => {
      const input: Record<string, unknown> = { logoUrl: logoUrl.trim() || null, brandColor: useColor ? color : null };
      if (isAdmin) input.name = name;
      if (role === "owner" && slug !== org.slug) input.slug = slug;
      const r = await updateOrganizationAction(org.id, input);
      if (!r.ok) { setError(r.error.message); return; }
      toast.success("Settings saved"); router.refresh();
    });
  };
  const leave = () => {
    if (!window.confirm("Leave this team?")) return;
    start(async () => {
      const r = await leaveOrganizationAction(org.id);
      if (!r.ok) toast.error(r.error.message); else { toast.success("You left the team"); router.push("/dashboard/teams"); router.refresh(); }
    });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader><CardTitle>Organization</CardTitle><CardDescription>Name, public URL and branding shown on your team booking pages.</CardDescription></CardHeader>
        <CardContent>
          <form onSubmit={save} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="o-name">Name</Label>
              <Input id="o-name" required minLength={2} maxLength={80} value={name} disabled={!isAdmin} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="o-slug">Public URL</Label>
              <div className="flex items-center gap-1 text-sm text-muted-foreground">
                <span className="shrink-0">{origin ? origin.replace(/^https?:\/\//, "") : ""}/</span>
                <Input id="o-slug" value={slug} disabled={role !== "owner"} aria-invalid={!!slugMsg} minLength={3} maxLength={30}
                  onChange={(e) => { setSlug(e.target.value.toLowerCase()); setSlugMsg(null); }}
                  onBlur={async () => { if (slug !== org.slug) { const r = await checkOrgSlugAction(slug, org.id); setSlugMsg(r.available ? null : (r.message ?? "Not available")); } }} />
              </div>
              {slugMsg ? <p className="text-xs text-destructive" role="alert">{slugMsg}</p> : role !== "owner" ? <p className="text-xs text-muted-foreground">Only an owner can change the URL.</p> : <p className="text-xs text-muted-foreground">Changing the URL breaks existing links.</p>}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="o-logo">Logo URL</Label>
              <div className="flex items-center gap-3">
                <Avatar src={logoUrl || null} name={name} />
                <Input id="o-logo" type="url" placeholder="https://..." value={logoUrl} disabled={!canBrand} onChange={(e) => setLogoUrl(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="o-color">Brand color</Label>
              <div className="flex items-center gap-3">
                <input id="o-color" type="color" value={color} disabled={!canBrand || !useColor} onChange={(e) => setColor(e.target.value)} className="h-9 w-12 cursor-pointer rounded border border-input bg-card" />
                <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={useColor} disabled={!canBrand} onChange={(e) => setUseColor(e.target.checked)} /> Use a custom color</label>
              </div>
            </div>
            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
            {canBrand ? <Button type="submit" loading={pending} disabled={!!slugMsg}>Save changes</Button> : <p className="text-sm text-muted-foreground">You need admin rights to change these settings.</p>}
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Leave team</CardTitle><CardDescription>You will lose access to team event types and bookings. Owners must transfer ownership first.</CardDescription></CardHeader>
        <CardContent><Button variant="destructive" loading={pending} onClick={leave}>Leave team</Button></CardContent>
      </Card>
    </div>
  );
}
