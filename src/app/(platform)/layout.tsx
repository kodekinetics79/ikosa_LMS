import { redirect } from "next/navigation";
import { ProductShell } from "@/components/product-shell";
import { principalFromCookies } from "@/lib/server/auth";
import { tenantShellContext } from "@/lib/server/tenant-runtime";

/**
 * Authoritative access control for every authenticated screen.
 *
 * The proxy gate only checks that a cookie exists; this layout resolves and
 * validates the session on the server before any protected screen renders, and
 * supplies the real signed-in identity so the shell never displays a fabricated
 * user or workspace. The tenant/org lookup follows the same datastore seam as
 * authentication: PostgreSQL in deployment, JSON only in local/demo mode.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  let identity;
  try {
    const principal = await principalFromCookies();
    const { tenant, organizations } = await tenantShellContext(principal);
    identity = {
      displayName: principal.user.displayName,
      email: principal.user.email,
      roles: principal.roles,
      tenantName: tenant?.name ?? "Unknown workspace",
      organizationCount: organizations.length,
    };
  } catch {
    redirect("/login");
  }

  return <ProductShell identity={identity}>{children}</ProductShell>;
}
