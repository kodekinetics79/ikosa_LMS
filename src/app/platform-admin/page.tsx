import { redirect } from "next/navigation";
import { PlatformAdminClient } from "./platform-admin-client";
import { platformPrincipalFromCookies } from "@/lib/server/platform-admin";
import { listManagedTenants } from "@/lib/server/platform-admin-portfolio";

export const dynamic = "force-dynamic";

export default async function PlatformAdminPage() {
  try {
    const principal = await platformPrincipalFromCookies();
    const tenants = await listManagedTenants();
    return <PlatformAdminClient operator={principal.operator} csrfToken={principal.csrfToken} initialTenants={tenants} />;
  } catch {
    redirect("/platform-admin/login");
  }
}
