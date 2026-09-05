import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { Pool, type PoolClient } from "pg";
import { hashPassword, verifyPassword } from "./security";
import { secureAttribute } from "./session-cookie";

export const PLATFORM_SESSION_COOKIE = "ik_platform_session";
const PLATFORM_SESSION_HOURS = 8;
const DEFAULT_PLATFORM_MODULES = ["learn", "assess", "live", "ai", "skills", "tna", "evidence", "credentials", "insights"] as const;

export type PlatformModule = (typeof DEFAULT_PLATFORM_MODULES)[number];
export type TenantKind = "education" | "corporate" | "training_provider" | "ngo";
export type TenantState = "trial" | "active" | "suspended";

export type PlatformOperator = {
  id: string;
  email: string;
  displayName: string;
};

export type PlatformPrincipal = {
  operator: PlatformOperator;
  csrfToken: string;
  sessionToken: string;
};

export type PlatformTenant = {
  id: string;
  slug: string;
  name: string;
  homeRegion: string;
  locale: string;
  createdAt: string;
  tenantKind: TenantKind;
  state: TenantState;
  planCode: string;
  seatLimit: number;
  storageGb: number;
  aiMonthlyCredits: number;
  enabledModules: PlatformModule[];
  trialEndsAt: string | null;
  firstAdminEmail: string | null;
};

export type CreateTenantInput = {
  name: string;
  slug: string;
  tenantKind: TenantKind;
  homeRegion: string;
  locale: string;
  planCode: string;
  seatLimit: number;
  storageGb: number;
  aiMonthlyCredits: number;
  enabledModules: PlatformModule[];
  trialDays: number;
  adminName: string;
  adminEmail: string;
  adminPassword: string;
};

export class PlatformAdminError extends Error {
  constructor(public status: 400 | 401 | 403 | 409 | 503, message: string) {
    super(message);
  }
}

let pool: Pool | null = null;

function controlPlaneUrl(): string {
  const dedicated = process.env.CONTROL_PLANE_DATABASE_URL?.trim();
  if (dedicated) return dedicated;
  if (process.env.NODE_ENV !== "production" && process.env.DATABASE_URL) return process.env.DATABASE_URL;
  throw new PlatformAdminError(503, "CONTROL_PLANE_DATABASE_URL is not configured");
}

function db(): Pool {
  if (!pool) pool = new Pool({ connectionString: controlPlaneUrl(), max: 4 });
  return pool;
}

function authSecret(): string {
  const configured = process.env.PLATFORM_AUTH_SECRET?.trim();
  if (configured && configured.length >= 32) return configured;
  if (process.env.NODE_ENV === "production") throw new PlatformAdminError(503, "PLATFORM_AUTH_SECRET is not configured");
  return "development-platform-auth-secret-change-me-before-production";
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function deriveCsrf(sessionToken: string): string {
  return createHmac("sha256", authSecret()).update(`platform-csrf:v1:${sessionToken}`).digest("base64url");
}

function tokensEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}

function randomToken(bytes = 32): string {
  return crypto.getRandomValues(new Uint8Array(bytes)).reduce((out, value) => out + value.toString(16).padStart(2, "0"), "");
}

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function assertCreateTenant(input: CreateTenantInput): CreateTenantInput {
  const name = input.name.trim();
  const slug = normalizeSlug(input.slug || name);
  const adminName = input.adminName.trim();
  const adminEmail = normalizeEmail(input.adminEmail);
  const homeRegion = input.homeRegion.trim();
  const locale = input.locale.trim();
  const planCode = input.planCode.trim().toLowerCase();
  const allowedKinds: TenantKind[] = ["education", "corporate", "training_provider", "ngo"];
  if (name.length < 2 || name.length > 120) throw new PlatformAdminError(400, "Tenant name must be between 2 and 120 characters");
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) throw new PlatformAdminError(400, "Tenant slug is invalid");
  if (!allowedKinds.includes(input.tenantKind)) throw new PlatformAdminError(400, "Tenant type is invalid");
  if (!homeRegion || !locale || !planCode) throw new PlatformAdminError(400, "Region, locale and plan are required");
  if (!adminName || !/^\S+@\S+\.\S+$/.test(adminEmail)) throw new PlatformAdminError(400, "A valid first administrator is required");
  if (input.adminPassword.length < 12) throw new PlatformAdminError(400, "The first administrator password must be at least 12 characters");
  const enabledModules = [...new Set(input.enabledModules)].filter((item): item is PlatformModule => DEFAULT_PLATFORM_MODULES.includes(item as PlatformModule));
  if (enabledModules.length === 0) throw new PlatformAdminError(400, "Enable at least one product module");
  return {
    ...input,
    name,
    slug,
    adminName,
    adminEmail,
    homeRegion,
    locale,
    planCode,
    enabledModules,
    seatLimit: Math.max(1, Math.min(1_000_000, Math.trunc(input.seatLimit))),
    storageGb: Math.max(1, Math.min(100_000, Math.trunc(input.storageGb))),
    aiMonthlyCredits: Math.max(0, Math.min(100_000_000, Math.trunc(input.aiMonthlyCredits))),
    trialDays: Math.max(0, Math.min(180, Math.trunc(input.trialDays))),
  };
}

async function ensureBootstrapOperator(client: PoolClient, email: string, password: string): Promise<void> {
  const existing = await client.query<{ count: string }>("SELECT count(*)::text AS count FROM osa.platform_operators");
  if (Number(existing.rows[0]?.count ?? "0") > 0) return;

  const bootstrapEmail = (process.env.PLATFORM_ADMIN_EMAIL ?? (process.env.NODE_ENV === "production" ? "" : "owner@platform.local")).trim().toLowerCase();
  const bootstrapPassword = process.env.PLATFORM_ADMIN_PASSWORD ?? (process.env.NODE_ENV === "production" ? "" : "ChangeMe!2026");
  const bootstrapName = (process.env.PLATFORM_ADMIN_NAME ?? "Platform Owner").trim();
  if (!bootstrapEmail || !bootstrapPassword) throw new PlatformAdminError(503, "Platform owner bootstrap credentials are not configured");
  if (email !== bootstrapEmail || password !== bootstrapPassword) return;

  await client.query(
    `INSERT INTO osa.platform_operators (email, display_name, password_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (email) DO NOTHING`,
    [bootstrapEmail, bootstrapName, hashPassword(bootstrapPassword)],
  );
}

export async function platformLogin(emailValue: string, password: string): Promise<PlatformPrincipal> {
  const email = normalizeEmail(emailValue);
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    await ensureBootstrapOperator(client, email, password);
    const result = await client.query<{ id: string; email: string; display_name: string; password_hash: string; active: boolean }>(
      `SELECT id::text, email::text, display_name, password_hash, active
       FROM osa.platform_operators WHERE email = $1`,
      [email],
    );
    const operator = result.rows[0];
    if (!operator || !operator.active || !verifyPassword(password, operator.password_hash)) {
      await client.query("ROLLBACK");
      throw new PlatformAdminError(401, "Invalid platform credentials");
    }

    const sessionToken = randomToken();
    const csrfToken = deriveCsrf(sessionToken);
    await client.query(
      `INSERT INTO osa.platform_sessions (id_hash, operator_id, csrf_hash, expires_at)
       VALUES ($1, $2::uuid, $3, now() + ($4 || ' hours')::interval)`,
      [sha256(sessionToken), operator.id, sha256(csrfToken), PLATFORM_SESSION_HOURS],
    );
    await client.query("UPDATE osa.platform_operators SET last_login_at = now() WHERE id = $1::uuid", [operator.id]);
    await client.query(
      `INSERT INTO osa.platform_audit_events (operator_id, action, resource_type, outcome, metadata)
       VALUES ($1::uuid, 'platform.auth.login', 'platform_session', 'success', '{}'::jsonb)`,
      [operator.id],
    );
    await client.query("COMMIT");
    return { operator: { id: operator.id, email: operator.email, displayName: operator.display_name }, csrfToken, sessionToken };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  } finally {
    client.release();
  }
}

export async function platformPrincipalFromToken(sessionToken: string | null): Promise<PlatformPrincipal> {
  if (!sessionToken) throw new PlatformAdminError(401, "Platform sign-in required");
  const csrfToken = deriveCsrf(sessionToken);
  const result = await db().query<{ id: string; email: string; display_name: string; csrf_hash: Buffer }>(
    `SELECT o.id::text, o.email::text, o.display_name, s.csrf_hash
     FROM osa.platform_sessions s
     JOIN osa.platform_operators o ON o.id = s.operator_id
     WHERE s.id_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND o.active = true`,
    [sha256(sessionToken)],
  );
  const row = result.rows[0];
  if (!row || !tokensEqual(row.csrf_hash, sha256(csrfToken))) throw new PlatformAdminError(401, "Platform session expired");
  return { operator: { id: row.id, email: row.email, displayName: row.display_name }, csrfToken, sessionToken };
}

export async function platformPrincipalFromCookies(): Promise<PlatformPrincipal> {
  const store = await cookies();
  return platformPrincipalFromToken(store.get(PLATFORM_SESSION_COOKIE)?.value ?? null);
}

export function assertPlatformCsrf(request: Request, principal: PlatformPrincipal): void {
  const presented = request.headers.get("x-csrf-token") ?? "";
  const left = Buffer.from(presented, "utf8");
  const right = Buffer.from(principal.csrfToken, "utf8");
  if (!presented || left.length !== right.length || !timingSafeEqual(left, right)) throw new PlatformAdminError(403, "Invalid platform CSRF token");
}

export function serializePlatformCookie(sessionToken: string, request: Request): string {
  // Same rule as the tenant session cookie: `Secure` unless the connection is
  // demonstrably a trustworthy origin. See session-cookie.ts::cookieIsSecure.
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${PLATFORM_SESSION_HOURS * 3600}${secureAttribute(request)}`;
}

export function clearPlatformCookie(): string {
  return `${PLATFORM_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export async function platformLogout(principal: PlatformPrincipal): Promise<void> {
  await db().query("UPDATE osa.platform_sessions SET revoked_at = now() WHERE id_hash = $1", [sha256(principal.sessionToken)]);
}

export async function listPlatformTenants(): Promise<PlatformTenant[]> {
  const result = await db().query<{
    id: string; slug: string; name: string; home_region: string; locale: string; created_at: Date;
    tenant_kind: TenantKind; state: TenantState; plan_code: string; seat_limit: number; storage_gb: number;
    ai_monthly_credits: number; enabled_modules: PlatformModule[]; trial_ends_at: Date | null; first_admin_email: string | null;
  }>(
    `SELECT t.id::text, t.slug, t.name, t.home_region, t.locale, t.created_at,
            c.tenant_kind, c.state, c.plan_code, c.seat_limit, c.storage_gb,
            c.ai_monthly_credits, c.enabled_modules, c.trial_ends_at,
            (SELECT u.email::text FROM osa.users u JOIN osa.user_roles r ON r.tenant_id = u.tenant_id AND r.user_id = u.id
             WHERE u.tenant_id = t.id AND r.role_code = 'tenant_admin' ORDER BY u.created_at ASC LIMIT 1) AS first_admin_email
     FROM osa.tenants t
     JOIN osa.tenant_control c ON c.tenant_id = t.id
     ORDER BY t.created_at DESC`,
  );
  return result.rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    homeRegion: row.home_region,
    locale: row.locale,
    createdAt: row.created_at.toISOString(),
    tenantKind: row.tenant_kind,
    state: row.state,
    planCode: row.plan_code,
    seatLimit: row.seat_limit,
    storageGb: row.storage_gb,
    aiMonthlyCredits: row.ai_monthly_credits,
    enabledModules: row.enabled_modules,
    trialEndsAt: row.trial_ends_at?.toISOString() ?? null,
    firstAdminEmail: row.first_admin_email,
  }));
}

export async function createPlatformTenant(principal: PlatformPrincipal, raw: CreateTenantInput): Promise<PlatformTenant> {
  const input = assertCreateTenant(raw);
  const client = await db().connect();
  try {
    await client.query("BEGIN");
    const duplicate = await client.query("SELECT 1 FROM osa.tenants WHERE slug = $1", [input.slug]);
    if (duplicate.rowCount) throw new PlatformAdminError(409, "A tenant with this slug already exists");

    const tenant = await client.query<{ id: string; created_at: Date }>(
      `INSERT INTO osa.tenants (slug, name, home_region, locale)
       VALUES ($1, $2, $3, $4) RETURNING id::text, created_at`,
      [input.slug, input.name, input.homeRegion, input.locale],
    );
    const tenantId = tenant.rows[0].id;
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    await client.query("SELECT set_config('app.user_id', '00000000-0000-0000-0000-000000000000', true)");

    const org = await client.query<{ id: string; path: string }>(
      `INSERT INTO osa.org_units (tenant_id, code, name, path)
       VALUES ($1::uuid, 'ROOT', $2, text2ltree($3)) RETURNING id::text, path::text`,
      [tenantId, input.name, `root_${tenantId.replaceAll("-", "_")}`],
    );
    const root = org.rows[0];
    const admin = await client.query<{ id: string }>(
      `INSERT INTO osa.users (tenant_id, org_unit_id, email, display_name, password_hash, delegated_org_paths)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, ARRAY[$6::ltree]) RETURNING id::text`,
      [tenantId, root.id, input.adminEmail, input.adminName, hashPassword(input.adminPassword), root.path],
    );
    await client.query(
      `INSERT INTO osa.user_roles (tenant_id, user_id, role_code) VALUES ($1::uuid, $2::uuid, 'tenant_admin')`,
      [tenantId, admin.rows[0].id],
    );
    const trialEndsAt = input.trialDays > 0 ? new Date(Date.now() + input.trialDays * 86_400_000) : null;
    await client.query(
      `INSERT INTO osa.tenant_control
        (tenant_id, tenant_kind, state, plan_code, seat_limit, storage_gb, ai_monthly_credits, enabled_modules, trial_ends_at, created_by_operator_id)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10::uuid)`,
      [tenantId, input.tenantKind, input.trialDays > 0 ? "trial" : "active", input.planCode, input.seatLimit, input.storageGb, input.aiMonthlyCredits, input.enabledModules, trialEndsAt, principal.operator.id],
    );
    await client.query(
      `INSERT INTO osa.platform_audit_events (operator_id, action, resource_type, resource_id, outcome, metadata)
       VALUES ($1::uuid, 'platform.tenant.create', 'tenant', $2::uuid, 'success', jsonb_build_object('slug', $3, 'firstAdmin', $4))`,
      [principal.operator.id, tenantId, input.slug, input.adminEmail],
    );
    await client.query("COMMIT");

    return {
      id: tenantId,
      slug: input.slug,
      name: input.name,
      homeRegion: input.homeRegion,
      locale: input.locale,
      createdAt: tenant.rows[0].created_at.toISOString(),
      tenantKind: input.tenantKind,
      state: input.trialDays > 0 ? "trial" : "active",
      planCode: input.planCode,
      seatLimit: input.seatLimit,
      storageGb: input.storageGb,
      aiMonthlyCredits: input.aiMonthlyCredits,
      enabledModules: input.enabledModules,
      trialEndsAt: trialEndsAt?.toISOString() ?? null,
      firstAdminEmail: input.adminEmail,
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* transaction already closed */ }
    throw error;
  } finally {
    client.release();
  }
}

export const platformModules = DEFAULT_PLATFORM_MODULES;
