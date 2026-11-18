import type { Metadata } from "next";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { requireUser } from "@/lib/auth-session";
import { db, schema } from "@/server/db";
import { PageHeader } from "@/components/ui/page-header";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProfileForm } from "./_components/profile-form";
import { SecuritySection } from "./_components/security-section";
import { DataSection } from "./_components/data-section";

export const metadata: Metadata = { title: "Settings" };
export const instant = false;

function countries(): { code: string; name: string }[] {
  const dn = new Intl.DisplayNames(["en"], { type: "region" });
  const out: { code: string; name: string }[] = [];
  for (let a = 65; a <= 90; a++) for (let b = 65; b <= 90; b++) {
    const code = String.fromCharCode(a, b);
    try { const name = dn.of(code); if (name && name !== code) out.push({ code, name }); } catch { /* invalid region */ }
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

const LANGUAGES = [
  { code: "en", name: "English" }, { code: "es", name: "Espanol" }, { code: "fr", name: "Francais" }, { code: "de", name: "Deutsch" },
  { code: "pt", name: "Portugues" }, { code: "hi", name: "Hindi" }, { code: "ja", name: "Japanese" },
];

export default async function SettingsPage() {
  const session = await requireUser();
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, session.id)).limit(1);
  const accounts = await db.select({ providerId: schema.accounts.providerId }).from(schema.accounts).where(eq(schema.accounts.userId, session.id));
  const hasPassword = accounts.some((a) => a.providerId === "credential");
  const timeZones = Intl.supportedValuesOf("timeZone");

  return (
    <div>
      <PageHeader title="Settings" description="Manage your profile, security and data." />
      <Tabs defaultValue="profile">
        <div className="max-w-full overflow-x-auto"><TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="security">Account &amp; security</TabsTrigger>
          <TabsTrigger value="data">Data &amp; privacy</TabsTrigger>
          <TabsTrigger value="developer">Developer</TabsTrigger>
        </TabsList></div>
        <TabsContent value="profile">
          <ProfileForm
            countries={countries()} languages={LANGUAGES} timeZones={timeZones}
            initial={{
              name: u!.name, username: u!.username ?? "", bio: u!.bio ?? "", phone: u!.phone ?? "", country: u!.country ?? "",
              language: u!.language, timeZone: u!.timeZone, dateFormat: u!.dateFormat, timeFormat: u!.timeFormat, image: u!.image,
              email: u!.email,
            }}
          />
        </TabsContent>
        <TabsContent value="security">
          <SecuritySection email={u!.email} hasPassword={hasPassword} twoFactorEnabled={Boolean(u!.twoFactorEnabled)} providers={accounts.map((a) => a.providerId).filter((p) => p !== "credential")} />
        </TabsContent>
        <TabsContent value="developer">
          <div className="grid gap-3 text-sm lg:max-w-2xl">
            <Link href="/dashboard/settings/api-keys" className="rounded-xl border bg-card p-4 hover:bg-accent"><b>API keys</b><p className="text-muted-foreground">Create and revoke keys for the public API.</p></Link>
            <Link href="/dashboard/settings/webhooks" className="rounded-xl border bg-card p-4 hover:bg-accent"><b>Webhooks</b><p className="text-muted-foreground">Send booking events to your own endpoints.</p></Link>
          </div>
        </TabsContent>
        <TabsContent value="data"><DataSection email={u!.email} hasPassword={hasPassword} /></TabsContent>
      </Tabs>
    </div>
  );
}
