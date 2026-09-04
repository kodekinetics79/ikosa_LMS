import { NextResponse } from "next/server";
import {
  PlatformAdminError,
  assertPlatformCsrf,
  createPlatformTenant,
  platformPrincipalFromToken,
  PLATFORM_SESSION_COOKIE,
  type CreateTenantInput,
  type TenantState,
} from "@/lib/server/platform-admin";
import { listManagedTenants } from "@/lib/server/platform-admin-portfolio";
import { setManagedTenantState } from "@/lib/server/platform-admin-lifecycle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function cookieValue(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

async function principal(request: Request) {
  return platformPrincipalFromToken(cookieValue(request, PLATFORM_SESSION_COOKIE));
}

export async function GET(request: Request): Promise<Response> {
  try {
    await principal(request);
    return NextResponse.json({ tenants: await listManagedTenants() });
  } catch (error) {
    const status = error instanceof PlatformAdminError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to load tenants" }, { status });
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = await principal(request);
    assertPlatformCsrf(request, actor);
    const body = await request.json() as CreateTenantInput;
    const tenant = await createPlatformTenant(actor, body);
    return NextResponse.json({ tenant }, { status: 201 });
  } catch (error) {
    const status = error instanceof PlatformAdminError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create tenant" }, { status });
  }
}

export async function PATCH(request: Request): Promise<Response> {
  try {
    const actor = await principal(request);
    assertPlatformCsrf(request, actor);
    const body = await request.json() as { tenantId?: string; state?: TenantState };
    if (!body.tenantId || !body.state || !(["trial", "active", "suspended"] as const).includes(body.state)) {
      return NextResponse.json({ error: "Tenant and valid target state are required" }, { status: 400 });
    }
    const result = await setManagedTenantState(actor, body.tenantId, body.state);
    return NextResponse.json(result);
  } catch (error) {
    const status = error instanceof PlatformAdminError ? error.status : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to change tenant state" }, { status });
  }
}
