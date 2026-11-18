import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth-session";
import { enabledSocialProviders } from "@/lib/auth";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { LoginForm } from "../_components/login-form";
import { OAuthButtons } from "../_components/oauth-buttons";
import { safeNext } from "../_components/safe-next";

export const metadata: Metadata = { title: "Sign in" };

async function Content({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  if (await getSession()) redirect(next);
  return (
    <Card>
      <CardHeader><CardTitle className="text-xl">Welcome back</CardTitle><CardDescription>Sign in to your account</CardDescription></CardHeader>
      <CardContent>
        <OAuthButtons {...enabledSocialProviders} next={next} />
        <LoginForm next={next} />
        <p className="mt-5 text-center text-sm text-muted-foreground">New here? <Link href="/signup" className="text-brand hover:underline">Create an account</Link></p>
      </CardContent>
    </Card>
  );
}

export default function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  return (
    <Suspense fallback={<Card><CardContent className="h-72" /></Card>}>
      <Content searchParams={searchParams} />
    </Suspense>
  );
}
