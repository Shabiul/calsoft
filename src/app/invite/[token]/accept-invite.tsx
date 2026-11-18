"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { authClient } from "@/lib/auth-client";
import { acceptInvitationAction } from "./actions";

export function AcceptInvite({ token, orgName }: { token: string; orgName: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      <Button className="w-full" loading={pending} onClick={() => start(async () => {
        setError(null);
        const r = await acceptInvitationAction(token);
        if (!r.ok) { setError(r.error.message); return; }
        router.push(`/dashboard/teams/${r.data.organizationId}`);
        router.refresh();
      })}>Accept and join {orgName}</Button>
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    </div>
  );
}

export function SwitchAccount({ next }: { next: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button className="w-full" variant="secondary" loading={pending} onClick={() => start(async () => {
      await authClient.signOut();
      router.push(`/login?next=${encodeURIComponent(next)}`);
      router.refresh();
    })}>Sign out and switch account</Button>
  );
}
