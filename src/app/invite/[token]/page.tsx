import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { CalendarCheck } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, Skeleton } from "@/components/ui";
import { getSession } from "@/lib/auth-session";
import { APP_NAME } from "@/lib/brand";
import { getInvitationPreview } from "@/server/services/organizations";
import { AcceptInvite, SwitchAccount } from "./accept-invite";

export const metadata: Metadata = { title: "Team invitation", robots: { index: false, follow: false } };
// Depends on the signed-in session; always rendered per request.
export const instant = false;

type P = { params: Promise<{ token: string }> };

export default function InvitePage({ params }: P) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <Link href="/" className="mb-8 flex items-center gap-2 text-lg font-semibold">
        <span className="flex size-8 items-center justify-center rounded-lg bg-brand text-brand-foreground"><CalendarCheck className="size-4" /></span>
        {APP_NAME}
      </Link>
      <div className="w-full max-w-sm">
        <Suspense fallback={<Card><CardContent className="p-5"><Skeleton className="h-32" /></CardContent></Card>}>
          <Content params={params} />
        </Suspense>
      </div>
    </div>
  );
}

async function Content({ params }: P) {
  const { token } = await params;
  const inv = await getInvitationPreview(token);
  if (inv.status === "invalid") {
    return <Msg title="Invitation not found" body="This link is invalid or was revoked. Ask a team admin to send you a new invitation." />;
  }
  if (inv.status === "accepted") {
    return <Msg title="Invitation already used" body={`This invitation to ${inv.orgName} has already been accepted.`} cta={{ href: "/dashboard/teams", label: "Go to your teams" }} />;
  }
  if (inv.status === "expired") {
    return <Msg title="Invitation expired" body={`This invitation to ${inv.orgName} has expired. Ask a team admin to send a new one.`} />;
  }
  const session = await getSession();
  const next = encodeURIComponent(`/invite/${token}`);
  const role = inv.role === "admin" ? "an admin" : `a ${inv.role}`;
  const intro = `${inv.inviterName ?? "A teammate"} invited ${inv.email} to join ${inv.orgName} as ${role}.`;

  if (!session) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-xl">Join {inv.orgName}</CardTitle><CardDescription>{intro}</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {`Sign in with the company Zoho account ${inv.email} to accept.`}
          </p>
          <div className="flex flex-col gap-2">
            <Link href={`/login?next=${next}`} className="inline-flex h-9 items-center justify-center rounded-md bg-brand px-4 text-sm font-medium text-brand-foreground hover:opacity-90">
              Sign in with Zoho to accept
            </Link>
          </div>
        </CardContent>
      </Card>
    );
  }
  if (session.user.email.toLowerCase() !== inv.email!.toLowerCase()) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-xl">Wrong account</CardTitle><CardDescription>{intro}</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">You are signed in as {session.user.email}. Sign out and continue with {inv.email} to accept this invitation.</p>
          <SwitchAccount next={`/invite/${token}`} />
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader><CardTitle className="text-xl">Join {inv.orgName}</CardTitle><CardDescription>{intro}</CardDescription></CardHeader>
      <CardContent><AcceptInvite token={token} orgName={inv.orgName!} /></CardContent>
    </Card>
  );
}

function Msg({ title, body, cta }: { title: string; body: string; cta?: { href: string; label: string } }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-xl">{title}</CardTitle><CardDescription>{body}</CardDescription></CardHeader>
      {cta && <CardContent><Link href={cta.href} className="text-sm text-brand hover:underline">{cta.label}</Link></CardContent>}
    </Card>
  );
}
