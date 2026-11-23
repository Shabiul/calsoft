import type { Metadata } from "next";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth-session";
import { zohoLoginEnabled } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ZohoSignIn } from "../_components/oauth-buttons";
import { safeNext } from "../_components/safe-next";

export const metadata: Metadata = { title: "Sign in" };

type SP = { next?: string; error?: string };

async function Content({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  if (await getSession()) redirect(next);
  return (
    <Card>
      <CardHeader><CardTitle className="text-xl">Sign in</CardTitle><CardDescription>Use your company Zoho account.</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        {/* The error text comes from our auth server; shown as plain text (React escapes it). */}
        {sp.error && <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {sp.error === "access_denied" ? "Sign-in was cancelled." : "Sign-in failed. Only company Zoho accounts can sign in; use your work email."}
        </p>}
        {zohoLoginEnabled ? <ZohoSignIn next={next} />
          : <p className="text-sm text-muted-foreground">Sign-in is not configured yet: set ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and ALLOWED_EMAIL_DOMAINS.</p>}
        <p className="text-center text-xs text-muted-foreground">No account needed: your first sign-in with a work email sets one up.</p>
      </CardContent>
    </Card>
  );
}

export default function LoginPage({ searchParams }: { searchParams: Promise<SP> }) {
  return (
    <Suspense fallback={<Card><CardContent className="h-56" /></Card>}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}
