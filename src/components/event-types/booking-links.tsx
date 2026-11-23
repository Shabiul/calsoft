"use client";
import * as React from "react";
import Link from "next/link";
import { Check, Code2, Copy, ExternalLink, Link2, Mail, NotebookPen, Share2 } from "lucide-react";
import {
  Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
  EmptyState, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Tabs, TabsContent, TabsList, TabsTrigger, Textarea, toast,
} from "@/components/ui";
import { createContextLinkAction } from "@/app/(app)/dashboard/scheduled/actions";
import { copyText } from "./copy";

export type BookingLinkItem = { id: string; title: string; durationMinutes: number; color: string | null; group: string; path: string | null; embedPath: string | null; isActive: boolean; isOneOff: boolean };

function CopyButton({ text, label = "Copy", disabled }: { text: string; label?: string; disabled?: boolean }) {
  const [done, setDone] = React.useState(false);
  return (
    <Button type="button" variant="outline" size="sm" disabled={disabled} onClick={async () => {
      if (await copyText(text)) { setDone(true); toast.success("Copied to clipboard"); setTimeout(() => setDone(false), 1500); } else toast.error("Could not copy. Select the text and copy it manually.");
    }}>
      {done ? <Check /> : <Copy />} {done ? "Copied" : label}
    </Button>
  );
}

/**
 * Personal link for one prospect with internal meeting context. The context is stored on the server; the link only carries a
 * token (plus the prospect's own name/email to prefill the form). Single use: the first booking made through it gets the context.
 */
function ContextLinkDialog({ item, url, onClose }: { item: BookingLinkItem; url: string; onClose: () => void }) {
  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [link, setLink] = React.useState("");
  const [pending, start] = React.useTransition();
  const create = () => start(async () => {
    const r = await createContextLinkAction(item.id, notes);
    if (!r.ok) { toast.error(r.error.message); return; }
    const q = new URLSearchParams({ ctx: r.data.token });
    if (name.trim()) q.set("name", name.trim());
    if (email.trim()) q.set("email", email.trim());
    setLink(`${url}?${q}`);
  });
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link with meeting context: {item.title}</DialogTitle>
          <DialogDescription>Write what the meeting is about. Send the link to the prospect, or open it and book the time yourself. The context is saved on the booking for you and your team only; the prospect never sees it.</DialogDescription>
        </DialogHeader>
        {link ? (
          <div className="space-y-3">
            <Input readOnly value={link} aria-label="Personal booking link" onFocus={(e) => e.currentTarget.select()} />
            <div className="flex flex-wrap gap-2">
              <CopyButton text={link} label="Copy link" />
              <Button asChild size="sm"><a href={link} target="_blank" rel="noreferrer">Open &amp; book now</a></Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => { setLink(""); setNotes(""); setName(""); setEmail(""); }}>Make another</Button>
            </div>
            <p className="text-xs text-muted-foreground">Works for one booking. After that the link still opens the booking page, without the context.</p>
          </div>
        ) : (
          <div className="grid gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5"><Label htmlFor="cl-name">Prospect name (optional)</Label><Input id="cl-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} /></div>
              <div className="grid gap-1.5"><Label htmlFor="cl-email">Prospect email (optional)</Label><Input id="cl-email" type="email" value={email} maxLength={254} onChange={(e) => setEmail(e.target.value)} /></div>
            </div>
            <div className="grid gap-1.5"><Label htmlFor="cl-notes">Meeting context (internal)</Label>
              <Textarea id="cl-notes" rows={4} maxLength={5000} value={notes} onChange={(e) => setNotes(e.target.value)}
                placeholder="Who they are, what they need, where the deal stands." /></div>
            <Button className="justify-self-start" loading={pending} disabled={!notes.trim()} onClick={create}>Create link</Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const hexOnly = (c: string) => c.replace(/^#/, "");
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

export function buildSnippet(kind: "inline" | "widget" | "text", o: { origin: string; url: string; text: string; color: string }): string {
  const script = `<script src="${o.origin}/embed/widget.js" async></script>`;
  if (kind === "inline") return `<div data-meetflow-inline data-url="${o.url}" data-color="${hexOnly(o.color)}" style="min-width:320px;height:700px"></div>\n${script}`;
  if (kind === "widget") return `<div data-meetflow-widget data-url="${o.url}" data-text="${esc(o.text)}" data-color="${o.color}"></div>\n${script}`;
  return `<a href="#" data-meetflow-popup data-url="${o.url}">${esc(o.text)}</a>\n${script}`;
}

export function BookingLinks({ items, origin, hasUsername }: { items: BookingLinkItem[]; origin: string; hasUsername: boolean }) {
  const linkable = items.filter((i) => i.path);
  const [selectedId, setSelectedId] = React.useState(linkable[0]?.id ?? "");
  const selected = linkable.find((i) => i.id === selectedId) ?? linkable[0];
  const [kind, setKind] = React.useState<"inline" | "widget" | "text">("inline");
  const [text, setText] = React.useState("Schedule a meeting");
  const [color, setColor] = React.useState("#4f46e5");
  const browserOrigin = React.useSyncExternalStore(() => () => {}, () => window.location.origin, () => "");
  const liveOrigin = origin || browserOrigin;
  const [contextFor, setContextFor] = React.useState<BookingLinkItem | null>(null);

  if (items.length === 0) {
    return (
      <EmptyState icon={<Link2 />} title="No booking links yet" description="Create an event type and its public link will appear here."
        action={<Button asChild><Link href="/dashboard/event-types/new">Create event type</Link></Button>} />
    );
  }

  const fullUrl = (p: string) => `${liveOrigin}${p}`;
  const groups = [...new Set(items.map((i) => i.group))];
  const snippet = selected?.embedPath ? buildSnippet(kind, { origin: liveOrigin, url: fullUrl(selected.embedPath), text, color }) : "";
  const shareUrl = selected?.path ? fullUrl(selected.path) : "";
  const shareText = selected ? `Book a time with me: ${selected.title}` : "";
  const enc = encodeURIComponent;

  return (
    <div className="space-y-8">
      {!hasUsername ? (
        <p role="status" className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-sm">
          Personal links are unavailable until you set a username in your profile settings.
        </p>
      ) : null}

      {groups.map((g) => (
        <section key={g} aria-label={g}>
          <h2 className="mb-2 text-sm font-semibold text-muted-foreground">{g}</h2>
          <ul className="divide-y rounded-xl border bg-card">
            {items.filter((i) => i.group === g).map((i) => (
              <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: i.color ?? "var(--brand)" }} aria-hidden />
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 truncate text-sm font-medium">{i.title}{i.isOneOff ? <Badge variant="outline">One-off</Badge> : null}{!i.isActive ? <Badge variant="warning">Inactive</Badge> : null}</p>
                    <p className="truncate text-xs text-muted-foreground">{i.path ? fullUrl(i.path).replace(/^https?:\/\//, "") : "No public link yet"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <CopyButton text={i.path ? fullUrl(i.path) : ""} label="Copy link" disabled={!i.path} />
                  {i.path ? <Button asChild variant="ghost" size="icon" aria-label={`Open ${i.title}`}><a href={i.path} target="_blank" rel="noreferrer"><ExternalLink /></a></Button> : null}
                  <Button type="button" variant="ghost" size="sm" disabled={!i.path || !i.isActive} onClick={() => setContextFor(i)}><NotebookPen /> Link with context</Button>
                  <Button type="button" variant="ghost" size="sm" disabled={!i.path} onClick={() => { setSelectedId(i.id); document.getElementById("share-embed")?.scrollIntoView({ behavior: "smooth" }); }}><Share2 /> Share / embed</Button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {contextFor?.path && <ContextLinkDialog item={contextFor} url={fullUrl(contextFor.path)} onClose={() => setContextFor(null)} />}

      <Card id="share-embed">
        <CardHeader>
          <CardTitle>Share and embed</CardTitle>
          <CardDescription>Choose a link, then share it or put it on your website.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {linkable.length === 0 ? (
            <p className="text-sm text-muted-foreground">Set a username to generate shareable links and embed code.</p>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="share-event">Event type</Label>
                <Select value={selected?.id} onValueChange={setSelectedId}>
                  <SelectTrigger id="share-event"><SelectValue /></SelectTrigger>
                  <SelectContent>{linkable.map((i) => <SelectItem key={i.id} value={i.id}>{i.group} / {i.title}</SelectItem>)}</SelectContent>
                </Select>
              </div>

              <div>
                <p className="mb-2 text-sm font-medium">Share</p>
                <div className="flex flex-wrap gap-2">
                  <CopyButton text={shareUrl} label="Copy link" />
                  <Button asChild variant="outline" size="sm"><a href={`mailto:?subject=${enc(selected?.title ?? "")}&body=${enc(`${shareText}\n${shareUrl}`)}`}><Mail /> Email</a></Button>
                  <Button asChild variant="outline" size="sm"><a href={`https://twitter.com/intent/tweet?text=${enc(shareText)}&url=${enc(shareUrl)}`} target="_blank" rel="noreferrer noopener">X / Twitter</a></Button>
                  <Button asChild variant="outline" size="sm"><a href={`https://www.linkedin.com/sharing/share-offsite/?url=${enc(shareUrl)}`} target="_blank" rel="noreferrer noopener">LinkedIn</a></Button>
                  <Button asChild variant="outline" size="sm"><a href={`https://www.facebook.com/sharer/sharer.php?u=${enc(shareUrl)}`} target="_blank" rel="noreferrer noopener">Facebook</a></Button>
                  <Button asChild variant="outline" size="sm"><a href={`https://wa.me/?text=${enc(`${shareText} ${shareUrl}`)}`} target="_blank" rel="noreferrer noopener">WhatsApp</a></Button>
                </div>
              </div>

              <div>
                <p className="mb-2 flex items-center gap-2 text-sm font-medium"><Code2 className="size-4" /> Embed on your website</p>
                <Tabs value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
                  <TabsList>
                    <TabsTrigger value="inline">Inline</TabsTrigger>
                    <TabsTrigger value="widget">Popup widget</TabsTrigger>
                    <TabsTrigger value="text">Popup text</TabsTrigger>
                  </TabsList>
                  <TabsContent value="inline"><p className="mt-2 text-sm text-muted-foreground">Shows the booking page directly inside your page.</p></TabsContent>
                  <TabsContent value="widget"><p className="mt-2 text-sm text-muted-foreground">A floating button that opens the booking page in a popup.</p></TabsContent>
                  <TabsContent value="text"><p className="mt-2 text-sm text-muted-foreground">A text link that opens the booking page in a popup.</p></TabsContent>
                </Tabs>
                {kind !== "inline" ? (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5"><Label htmlFor="emb-text">Button / link text</Label><Input id="emb-text" value={text} maxLength={60} onChange={(e) => setText(e.target.value)} /></div>
                    {kind === "widget" ? (
                      <div className="space-y-1.5"><Label htmlFor="emb-color">Button colour</Label>
                        <input id="emb-color" type="color" className="h-9 w-16 cursor-pointer rounded-md border border-input bg-card p-1" value={color} onChange={(e) => setColor(e.target.value)} />
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <pre className="mt-3 overflow-x-auto rounded-lg border bg-muted p-3 text-xs" aria-label="Embed code"><code>{snippet}</code></pre>
                <div className="mt-2"><CopyButton text={snippet} label="Copy embed code" /></div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
