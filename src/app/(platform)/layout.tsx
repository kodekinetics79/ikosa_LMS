import { redirect } from "next/navigation";
import { ProductShell } from "@/components/product-shell";
import { principalFromCookies } from "@/lib/server/auth";
import { readDatabase } from "@/lib/server/store";

/**
 * Authoritative access control for every authenticated screen.
 *
 * The proxy gate only checks that a cookie exists; this layout resolves and
 * validates the session on the server before any protected screen renders, and
 * supplies the real signed-in identity so the shell never displays a fabricated
 * user or workspace.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  let identity;
  try {
    const principal = await principalFromCookies();
    const database = await readDatabase();
    const tenant = database.tenants.find((candidate) => candidate.id === principal.tenantId);
    identity = {
      displayName: principal.user.displayName,
      email: principal.user.email,
      roles: principal.roles,
      tenantName: tenant?.name ?? "Unknown workspace",
      organizationCount: database.orgUnits.filter((unit) => unit.tenantId === principal.tenantId).length,
    };
  } catch {
    redirect("/login");
  }

  return <ProductShell identity={identity}>{children}</ProductShell>;
}
