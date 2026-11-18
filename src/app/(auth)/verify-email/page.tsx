import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { MailCheck } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = { title: "Verify your email" };

/** Landing page for verification links that fail (?error=...) and for "check your inbox" redirects. */
async function Content({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <Card>
      <CardHeader>
        <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-brand/10 text-brand"><MailCheck className="size-5" /></div>
        <CardTitle className="text-xl">{error ? "Verification link problem" : "Check your inbox"}</CardTitle>
        <CardDescription>{error ? "That verification link is invalid or has expired. Sign in to request a new one." : "We sent you a verification link. Open it to activate your account."}</CardDescription>
      </CardHeader>
      <CardContent><Button asChild className="w-full"><Link href="/login">Go to sign in</Link></Button></CardContent>
    </Card>
  );
}

export default function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  return (
    <Suspense fallback={<Card><CardContent className="h-48" /></Card>}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}
