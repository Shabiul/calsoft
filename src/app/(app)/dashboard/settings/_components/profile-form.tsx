"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { FieldError, Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { validateUsername } from "@/lib/username";
import { checkUsernameAction, saveProfileAction } from "../actions";

interface Initial {
  name: string; username: string; bio: string; phone: string; country: string; language: string; timeZone: string;
  dateFormat: string; timeFormat: string; image: string | null; email: string;
}

export function ProfileForm({ initial, countries, languages, timeZones }: {
  initial: Initial; countries: { code: string; name: string }[]; languages: { code: string; name: string }[]; timeZones: string[];
}) {
  const router = useRouter();
  const [v, setV] = useState(initial);
  const [image, setImage] = useState(initial.image);
  const [uploading, setUploading] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [uname, setUname] = useState<{ ok: boolean; msg?: string } | null>(null);
  const [pending, start] = useTransition();
  const fileRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof Initial>(k: K, val: Initial[K]) => setV((p) => ({ ...p, [k]: val }));

  useEffect(() => {
    if (v.username === initial.username) { setUname(null); return; }
    const local = validateUsername(v.username);
    if (!local.ok) { setUname({ ok: false, msg: local.message }); return; }
    const t = setTimeout(async () => {
      const r = await checkUsernameAction(local.username);
      setUname(r.available ? { ok: true } : { ok: false, msg: r.message });
    }, 350);
    return () => clearTimeout(t);
  }, [v.username, initial.username]);

  function save(e: React.FormEvent) {
    e.preventDefault();
    setErrors({});
    start(async () => {
      const res = await saveProfileAction({ ...v, image: undefined });
      if (res.ok) { toast.success("Profile saved"); router.refresh(); return; }
      const map: Record<string, string> = {};
      res.error.issues?.forEach((i) => { map[i.path] = i.message; });
      setErrors(map);
      toast.error(res.error.message);
    });
  }

  async function upload(file: File) {
    setUploading(true);
    const fd = new FormData();
    fd.set("file", file);
    const r = await fetch("/api/settings/avatar", { method: "POST", body: fd });
    const j = (await r.json()) as { url?: string; error?: { message: string } };
    setUploading(false);
    if (!r.ok || !j.url) { toast.error(j.error?.message ?? "Upload failed"); return; }
    setImage(j.url);
    toast.success("Photo updated");
    router.refresh();
  }
  async function removePhoto() {
    const r = await fetch("/api/settings/avatar", { method: "DELETE" });
    if (r.ok) { setImage(null); toast.success("Photo removed"); router.refresh(); } else toast.error("Could not remove photo");
  }

  return (
    <form onSubmit={save} className="grid gap-6 lg:max-w-2xl">
      <Card>
        <CardHeader><CardTitle>Profile</CardTitle><CardDescription>This information appears on your public booking page.</CardDescription></CardHeader>
        <CardContent className="grid gap-5">
          <div className="flex items-center gap-4">
            <Avatar src={image} name={v.name} className="size-16 text-lg" />
            <div className="flex flex-wrap gap-2">
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
              <Button type="button" variant="secondary" size="sm" loading={uploading} onClick={() => fileRef.current?.click()}>Upload photo</Button>
              {image && <Button type="button" variant="ghost" size="sm" onClick={removePhoto}>Remove</Button>}
              <p className="w-full text-xs text-muted-foreground">PNG, JPEG, WebP or GIF, up to 2 MB.</p>
            </div>
          </div>
          <div className="grid gap-1.5"><Label htmlFor="name">Full name</Label>
            <Input id="name" value={v.name} onChange={(e) => set("name", e.target.value)} required maxLength={100} /><FieldError>{errors.name}</FieldError></div>
          <div className="grid gap-1.5"><Label htmlFor="email">Email</Label><Input id="email" value={v.email} disabled /></div>
          <div className="grid gap-1.5">
            <Label htmlFor="username">Username</Label>
            <div className="flex items-center rounded-md border border-input bg-card shadow-sm"><span className="pl-3 text-sm text-muted-foreground">/</span>
              <input id="username" value={v.username} onChange={(e) => set("username", e.target.value.toLowerCase())} className="h-9 w-full bg-transparent px-1 text-sm outline-none" required /></div>
            {uname && <p className={`text-xs ${uname.ok ? "text-success" : "text-destructive"}`}>{uname.ok ? "Available" : uname.msg}</p>}
            <FieldError>{errors.username}</FieldError>
          </div>
          <div className="grid gap-1.5"><Label htmlFor="bio">Bio</Label>
            <Textarea id="bio" value={v.bio} onChange={(e) => set("bio", e.target.value)} maxLength={500} placeholder="Tell invitees a bit about you" /></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5"><Label htmlFor="phone">Phone</Label>
              <Input id="phone" value={v.phone} onChange={(e) => set("phone", e.target.value)} type="tel" /><FieldError>{errors.phone}</FieldError></div>
            <div className="grid gap-1.5"><Label>Country</Label>
              <Select value={v.country || "none"} onValueChange={(x) => set("country", x === "none" ? "" : x)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="none">Not set</SelectItem>{countries.map((c) => <SelectItem key={c.code} value={c.code}>{c.name}</SelectItem>)}</SelectContent>
              </Select></div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Preferences</CardTitle><CardDescription>Language, time zone and how dates and times are displayed.</CardDescription></CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5"><Label>Language</Label>
            <Select value={v.language} onValueChange={(x) => set("language", x)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{languages.map((l) => <SelectItem key={l.code} value={l.code}>{l.name}</SelectItem>)}</SelectContent>
            </Select></div>
          <div className="grid gap-1.5"><Label>Time zone</Label>
            <Select value={v.timeZone} onValueChange={(x) => set("timeZone", x)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{(timeZones.includes(v.timeZone) ? timeZones : [v.timeZone, ...timeZones]).map((z) => <SelectItem key={z} value={z}>{z}</SelectItem>)}</SelectContent>
            </Select><FieldError>{errors.timeZone}</FieldError></div>
          <div className="grid gap-1.5"><Label>Date format</Label>
            <Select value={v.dateFormat} onValueChange={(x) => set("dateFormat", x)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="MM/dd/yyyy">MM/DD/YYYY</SelectItem><SelectItem value="dd/MM/yyyy">DD/MM/YYYY</SelectItem><SelectItem value="yyyy-MM-dd">YYYY-MM-DD</SelectItem></SelectContent>
            </Select></div>
          <div className="grid gap-1.5"><Label>Time format</Label>
            <Select value={v.timeFormat} onValueChange={(x) => set("timeFormat", x)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="12h">12-hour (2:30 PM)</SelectItem><SelectItem value="24h">24-hour (14:30)</SelectItem></SelectContent>
            </Select></div>
        </CardContent>
      </Card>
      <div><Button type="submit" loading={pending} disabled={uname?.ok === false}>Save changes</Button></div>
    </form>
  );
}
