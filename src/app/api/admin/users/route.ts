import { AuthError, assertCsrf, principalFromRequest } from "@/lib/server/auth";
import type { PlatformRole } from "@/lib/server/domain";
import { json, objectBody, problem, requestId, requiredString, ValidationError } from "@/lib/server/http";
import { createTenantUser, listTenantUsers, resetTenantUserPassword, setTenantUserActive } from "@/lib/server/tenant-admin-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROLES: readonly PlatformRole[] = ["tenant_admin", "tna_analyst", "manager", "assessor", "learner", "auditor"];

function requireTenantAdmin(roles: PlatformRole[]): void {
  if (!roles.includes("tenant_admin")) throw new AuthError(403, "Tenant administrator permission required");
}

function parseRoles(value: unknown): PlatformRole[] {
  if (!Array.isArray(value)) throw new ValidationError("Validation failed", { roles: "Select at least one role" });
  const requested = [...new Set(value.map(String))];
  const roles = requested.filter((role): role is PlatformRole => ROLES.includes(role as PlatformRole));
  if (roles.length === 0 || roles.length !== requested.length) {
    throw new ValidationError("Validation failed", { roles: "One or more roles are invalid" });
  }
  return roles;
}

export async function GET(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    requireTenantAdmin(principal.roles);
    return json({ items: await listTenantUsers(principal), asOf: new Date().toISOString() });
  } catch (error) { return problem(error, rid); }
}

export async function POST(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    requireTenantAdmin(principal.roles);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const email = requiredString(body, "email", 254).trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) throw new ValidationError("Validation failed", { email: "Enter a valid email address" });
    const password = requiredString(body, "password", 256);
    if (password.length < 12) throw new ValidationError("Validation failed", { password: "Temporary password must be at least 12 characters" });
    const roles = parseRoles(body.roles);
    try {
      const created = await createTenantUser(principal, {
        email,
        displayName: requiredString(body, "displayName", 160),
        orgUnitId: requiredString(body, "orgUnitId", 100),
        password,
        roles,
        requestId: rid,
      });
      return json(created, { status: 201 });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new ValidationError("Validation failed", { email: "A user with this email already exists in the tenant" });
      throw error;
    }
  } catch (error) { return problem(error, rid); }
}

export async function PATCH(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    requireTenantAdmin(principal.roles);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const userId = requiredString(body, "userId", 100);

    if (body.action === "reset_password") {
      const password = requiredString(body, "password", 256);
      if (password.length < 12) throw new ValidationError("Validation failed", { password: "Temporary password must be at least 12 characters" });
      const result = await resetTenantUserPassword(principal, userId, password, rid);
      return json({ ok: true, ...result });
    }

    if (typeof body.active !== "boolean") throw new ValidationError("Validation failed", { active: "Active state must be true or false" });
    await setTenantUserActive(principal, userId, body.active, rid);
    return json({ ok: true, userId, active: body.active });
  } catch (error) { return problem(error, rid); }
}
