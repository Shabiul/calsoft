import Link from "next/link";
import { CalendarCheck } from "lucide-react";
import { APP_NAME } from "@/lib/brand";
import { ThemeToggle } from "@/components/providers/theme-toggle";

// Every route under this layout depends on the signed-in session (cookies), so it renders per request.
export const instant = false;

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative flex min-h-screen flex-col items-center justify-center px-4 py-10">
      <div className="absolute right-4 top-4"><ThemeToggle /></div>
      <Link href="/" className="mb-8 flex items-center gap-2 text-lg font-semibold">
        <span className="flex size-8 items-center justify-center rounded-lg bg-brand text-brand-foreground"><CalendarCheck className="size-4" /></span>
        {APP_NAME}
      </Link>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
