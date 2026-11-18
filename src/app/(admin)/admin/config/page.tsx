import { PageHeader } from "@/components/ui/page-header";
import { Button } from "@/components/ui/button";
import { CONFIG_FIELDS, getPlatformConfig } from "@/server/admin";
import { saveConfigAction } from "../actions";
import { Flash, inputCls, type SP } from "../_components";

export default async function AdminConfig({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const cfg = await getPlatformConfig();
  return (
    <>
      <PageHeader title="Platform configuration" description="Stored in the database; every change is written to the audit log." />
      <Flash sp={sp} />
      <form action={saveConfigAction} className="max-w-xl space-y-4 rounded-xl border bg-card p-5">
        {Object.entries(CONFIG_FIELDS).map(([k, f]) => (
          <label key={k} className={f.type === "boolean" ? "flex items-center gap-2 text-sm" : "block text-sm"}>
            {f.type === "boolean" ? (
              <><input type="checkbox" name={k} defaultChecked={cfg[k as keyof typeof cfg] === true} /> {f.label}</>
            ) : (
              <>{f.label}<input name={k} defaultValue={String(cfg[k as keyof typeof cfg] ?? "")} className={`${inputCls} mt-1 w-full`} /></>
            )}
          </label>
        ))}
        <Button type="submit">Save configuration</Button>
      </form>
    </>
  );
}

export const instant = false;
