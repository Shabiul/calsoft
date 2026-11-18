import type { Metadata } from "next";
import { Suspense } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ResetForm } from "../_components/reset-form";

export const metadata: Metadata = { title: "Reset password" };

export default function ResetPasswordPage() {
  return (
    <Card>
      <CardHeader><CardTitle className="text-xl">Choose a new password</CardTitle></CardHeader>
      <CardContent><Suspense><ResetForm /></Suspense></CardContent>
    </Card>
  );
}
