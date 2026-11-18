import { redirect } from "next/navigation";

/** The sidebar links here; the list lives at /dashboard/scheduled. */
export default function ScheduledEventsRedirect() {
  redirect("/dashboard/scheduled");
}

export const instant = false;
