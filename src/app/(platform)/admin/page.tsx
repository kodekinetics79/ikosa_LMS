import { redirect } from "next/navigation";
import { principalFromCookies } from "@/lib/server/auth";
import { listTenantOrgUnits, listTenantUsers } from "@/lib/server/tenant-admin-store";
import { TenantAdminClient } from "./admin-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tenant administration" };

export default async function TenantAdminPage() {
  const principal = await principalFromCookies();
  if (!principal.roles.includes("tenant_admin")) redirect("/");

  const [users, organizations] = await Promise.all([
    listTenantUsers(principal),
    listTenantOrgUnits(principal),
  ]);

  return (
    <TenantAdminClient
      initialUsers={users}
      initialOrganizations={organizations}
      csrfToken={principal.session.csrfToken}
      currentUserId={principal.user.id}
    />
  );
}
