import { redirect } from "next/navigation";
import { PlatformAdminClient } from "./platform-admin-client";
import { listPlatformTenants, platformPrincipalFromCookies } from "@/lib/server/platform-admin";

export const dynamic = "force-dynamic";

export default async function PlatformAdminPage() {
  try {
    const principal = await platformPrincipalFromCookies();
    const tenants = await listPlatformTenants();
    return <PlatformAdminClient operator={principal.operator} csrfToken={principal.csrfToken} initialTenants={tenants} />;
  } catch {
    redirect("/platform-admin/login");
  }
}
