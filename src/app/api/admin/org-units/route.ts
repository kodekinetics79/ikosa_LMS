import { AuthError, assertCsrf, principalFromRequest } from "@/lib/server/auth";
import { json, objectBody, problem, requestId, requiredString, ValidationError } from "@/lib/server/http";
import { createTenantOrgUnit, listTenantOrgUnits } from "@/lib/server/tenant-admin-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function requireTenantAdmin(roles: readonly string[]): void {
  if (!roles.includes("tenant_admin")) throw new AuthError(403, "Tenant administrator permission required");
}

export async function GET(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    requireTenantAdmin(principal.roles);
    return json({ items: await listTenantOrgUnits(principal), asOf: new Date().toISOString() });
  } catch (error) { return problem(error, rid); }
}

export async function POST(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    requireTenantAdmin(principal.roles);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const code = requiredString(body, "code", 40).trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{1,39}$/.test(code)) {
      throw new ValidationError("Validation failed", { code: "Use 2-40 letters, numbers, underscores or hyphens" });
    }
    try {
      const created = await createTenantOrgUnit(principal, {
        parentId: requiredString(body, "parentId", 100),
        code,
        name: requiredString(body, "name", 160),
        requestId: rid,
      });
      return json(created, { status: 201 });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new ValidationError("Validation failed", { code: "This organization code already exists" });
      throw error;
    }
  } catch (error) { return problem(error, rid); }
}
