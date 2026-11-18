import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth-session";
import { enabledSocialProviders } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { SignupForm } from "../_components/signup-form";
import { OAuthButtons } from "../_components/oauth-buttons";
import { safeNext } from "../_components/safe-next";

export const metadata: Metadata = { title: "Create your account" };

async function Content({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  if (await getSession()) redirect(next);
  return (
    <Card>
      <CardHeader><CardTitle className="text-xl">Create your account</CardTitle><CardDescription>Free forever. No credit card required.</CardDescription></CardHeader>
      <CardContent>
        <OAuthButtons {...enabledSocialProviders} next={next} />
        <SignupForm next={next} />
        <p className="mt-5 text-center text-sm text-muted-foreground">Already have an account? <Link href="/login" className="text-brand hover:underline">Sign in</Link></p>
      </CardContent>
    </Card>
  );
}

export default function SignupPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  return (
    <Suspense fallback={<Card><CardContent className="h-72" /></Card>}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}
