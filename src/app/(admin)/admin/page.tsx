import { PageHeader } from "@/components/ui/page-header";
import { getOverview } from "@/server/admin";
import { Stat } from "./_components";

export default async function AdminOverview() {
  const o = await getOverview();
  return (
    <>
      <PageHeader title="Platform overview" description="Live counts straight from the database." />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label="Users" value={o.users} hint={`${o.suspended} suspended`} />
        <Stat label="Organizations" value={o.orgs} />
        <Stat label="Bookings" value={o.bookings} hint={`${o.bookings7d} created in the last 7 days`} />
        <Stat label="Active subscriptions" value={o.activeSubs} />
      </div>
    </>
  );
}

export const instant = false;
