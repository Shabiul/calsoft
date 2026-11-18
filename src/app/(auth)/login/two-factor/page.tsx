import type { Metadata } from "next";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { TwoFactorForm } from "../../_components/two-factor-form";

export const metadata: Metadata = { title: "Two-factor verification" };

export default function TwoFactorPage() {
  return (
    <Card>
      <CardHeader><CardTitle className="text-xl">Two-factor authentication</CardTitle><CardDescription>Enter the 6-digit code from your authenticator app, or a backup code.</CardDescription></CardHeader>
      <CardContent><TwoFactorForm /></CardContent>
    </Card>
  );
}
