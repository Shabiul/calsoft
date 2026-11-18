import type { Metadata } from "next";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { ForgotForm } from "../_components/forgot-form";

export const metadata: Metadata = { title: "Forgot password" };

export default function ForgotPasswordPage() {
  return (
    <Card>
      <CardHeader><CardTitle className="text-xl">Forgot your password?</CardTitle><CardDescription>Enter your email and we will send you a reset link.</CardDescription></CardHeader>
      <CardContent>
        <ForgotForm />
        <p className="mt-5 text-center text-sm"><Link href="/login" className="text-brand hover:underline">Back to sign in</Link></p>
      </CardContent>
    </Card>
  );
}
