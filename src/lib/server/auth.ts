import { cookies } from "next/headers";
import type { OrgUnit, PlatformRole, PublicUser, Session, User } from "./domain";
import { withoutSecrets } from "./domain";
import { appendAudit } from "./audit";
import { hashPassword, id, secureToken, verifyPassword } from "./security";
import { mutateDatabase, readDatabase } from "./store";

export { SESSION_COOKIE } from "./session-cookie";
import { SESSION_COOKIE } from "./session-cookie";
const SESSION_HOURS = 12;
const MAX_SESSIONS_PER_USER = 5;

/**
 * Per-process login throttle.
 *
 * Honest limitation: this is in-memory, so it protects a single instance only -
 * the same constraint the JSON datastore already imposes. It must move to a
 * shared store alongside the PostgreSQL migration. It is here because the
 * alternative today is no brute-force resistance whatsoever.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function throttleLogin(key: string): void {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return;
  }
  entry.count += 1;
  if (entry.count > LOGIN_MAX_ATTEMPTS) {
    throw new AuthError(401, "Too many sign-in attempts. Try again later.");
  }
}

function clearThrottle(key: string): void {
  loginAttempts.delete(key);
}

/** Same scrypt cost as a real credential, so a failed lookup is indistinguishable. */
const DECOY_PASSWORD_HASH = hashPassword("decoy-credential-never-matches");

export type Principal = {
  session: Session;
  user: PublicUser;
  tenantId: string;
  roles: PlatformRole[];
  delegatedOrgPaths: string[];
};

export class AuthError extends Error {
  constructor(public status: 401 | 403, message: string) {
    super(message);
  }
}

function cookieValue(request: Request, name: string): string | null {
  const cookies = request.headers.get("cookie") ?? "";
  for (const item of cookies.split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

export async function login(email: string, password: string, requestId: string, tenantSlug?: string): Promise<{ session: Session; user: PublicUser }> {
  const throttleKey = `${email.trim().toLowerCase()}|${tenantSlug ?? ""}`;
  throttleLogin(throttleKey);
  const database = await readDatabase();
  const matchingTenantId = tenantSlug ? database.tenants.find((tenant) => tenant.slug === tenantSlug.trim().toLowerCase())?.id : undefined;
  const candidates = database.users.filter((candidate) => candidate.email.toLowerCase() === email.trim().toLowerCase() && (!tenantSlug || candidate.tenantId === matchingTenantId));
  if (candidates.length > 1) throw new AuthError(401, "Tenant selection required");
  const user = candidates[0];

  // Timing equalisation. Previously an unknown address returned in well under a
  // millisecond while a real one spent ~90ms in scrypt, which let an attacker
  // enumerate valid accounts without ever authenticating. Always pay the same
  // cost, whether or not the account exists.
  const passwordMatches = user
    ? verifyPassword(password, user.passwordHash)
    : (verifyPassword(password, DECOY_PASSWORD_HASH), false);

  if (!user || !user.active || !passwordMatches) {
    // Record the attempt even when the account does not exist. Auditing only
    // known accounts makes credential stuffing against unknown addresses
    // invisible, and the release checklist requires authentication events.
    const attributedTenantId = user?.tenantId ?? matchingTenantId;
    if (attributedTenantId) {
      await appendAudit({
        tenantId: attributedTenantId,
        actorUserId: user?.id ?? null,
        action: "auth.login",
        resourceType: "session",
        resourceId: null,
        outcome: "failure",
        requestId,
        // No email or password material: the ledger is readable by auditors.
        metadata: { reason: user ? (user.active ? "invalid_credentials" : "account_inactive") : "unknown_account" },
      });
    }
    throw new AuthError(401, "Invalid credentials");
  }

  const session: Session = {
    id: secureToken(),
    userId: user.id,
    tenantId: user.tenantId,
    csrfToken: secureToken(24),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString(),
  };
  await mutateDatabase((state) => {
    // Prune expired sessions, and cap how many a single account may hold at
    // once. This previously deleted EVERY other session for the user, so
    // signing in on a second device silently signed you out of the first -
    // never a stated control, and wrong for field staff who use a shared
    // tablet and a phone. Keeping the newest few bounds credential sharing
    // without pretending one device is all anyone has.
    const live = state.sessions.filter((candidate) => new Date(candidate.expiresAt).getTime() > Date.now());
    const mine = live
      .filter((candidate) => candidate.userId === user.id)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, MAX_SESSIONS_PER_USER - 1)
      .map((candidate) => candidate.id);
    const keep = new Set(mine);
    state.sessions = live.filter((candidate) => candidate.userId !== user.id || keep.has(candidate.id));
    state.sessions.push(session);
  });
  clearThrottle(throttleKey);
  await appendAudit({ tenantId: user.tenantId, actorUserId: user.id, action: "auth.login", resourceType: "session", resourceId: session.id.slice(0, 12), outcome: "success", requestId });
  return { session, user: withoutSecrets(user) };
}

export async function logout(request: Request, requestId: string): Promise<void> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return;
  const database = await readDatabase();
  const session = database.sessions.find((candidate) => candidate.id === token);
  await mutateDatabase((state) => { state.sessions = state.sessions.filter((candidate) => candidate.id !== token); });
  if (session) await appendAudit({ tenantId: session.tenantId, actorUserId: session.userId, action: "auth.logout", resourceType: "session", resourceId: session.id.slice(0, 12), outcome: "success", requestId });
}

export async function resolvePrincipal(token: string | null): Promise<Principal> {
  if (!token) throw new AuthError(401, "Authentication required");
  const database = await readDatabase();
  const session = database.sessions.find((candidate) => candidate.id === token);
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) throw new AuthError(401, "Session expired");
  const user = database.users.find((candidate) => candidate.id === session.userId && candidate.tenantId === session.tenantId && candidate.active);
  if (!user) throw new AuthError(401, "Account is unavailable");
  return { session, user: withoutSecrets(user), tenantId: session.tenantId, roles: user.roles, delegatedOrgPaths: user.delegatedOrgPaths };
}

export async function principalFromRequest(request: Request): Promise<Principal> {
  return resolvePrincipal(cookieValue(request, SESSION_COOKIE));
}

/**
 * Server Component entry point. Reads the session from the async cookie store
 * (Next.js 16 removed synchronous access) so pages can resolve the real
 * principal instead of trusting anything rendered in the browser.
 */
export async function principalFromCookies(): Promise<Principal> {
  const store = await cookies();
  return resolvePrincipal(store.get(SESSION_COOKIE)?.value ?? null);
}

export function assertCsrf(request: Request, principal: Principal): void {
  if (request.headers.get("x-csrf-token") !== principal.session.csrfToken) throw new AuthError(403, "Invalid CSRF token");
}

export function serializeSessionCookie(session: Session): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}${secure}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export type Action =
  | "platform:read"
  | "tna:read" | "tna:create" | "tna:update"
  | "evidence:read" | "evidence:create" | "evidence:verify"
  | "gap:read" | "gap:update"
  | "intervention:read" | "intervention:create" | "intervention:update"
  | "course:read" | "course:create" | "course:update"
  | "signal:read" | "signal:triage"
  | "notification:read" | "notification:update"
  | "enrollment:read" | "enrollment:create" | "enrollment:update"
  | "audit:read";

const roleActions: Record<PlatformRole, Action[]> = {
  tenant_admin: ["signal:read", "signal:triage", "notification:read", "notification:update", "course:read", "course:create", "course:update", "enrollment:read", "enrollment:create", "enrollment:update", "platform:read", "tna:read", "tna:create", "tna:update", "evidence:read", "gap:read", "gap:update", "intervention:read", "intervention:create", "intervention:update", "audit:read"],
  tna_analyst: ["signal:read", "signal:triage", "notification:read", "notification:update", "course:read", "course:create", "course:update", "enrollment:read", "enrollment:create", "platform:read", "tna:read", "tna:create", "tna:update", "evidence:read", "gap:read", "gap:update", "intervention:read", "intervention:create", "intervention:update"],
  manager: ["signal:read", "notification:read", "notification:update", "course:read", "enrollment:read", "enrollment:create", "enrollment:update", "platform:read", "tna:read", "evidence:read", "evidence:create", "gap:read", "gap:update", "intervention:read", "intervention:update"],
  assessor: ["notification:read", "notification:update", "course:read", "enrollment:read", "platform:read", "evidence:read", "evidence:create", "evidence:verify", "gap:read"],
  learner: ["notification:read", "notification:update", "course:read", "enrollment:read", "enrollment:create", "enrollment:update", "platform:read", "evidence:read", "gap:read", "intervention:read"],
  auditor: ["signal:read", "notification:read", "course:read", "enrollment:read", "platform:read", "tna:read", "evidence:read", "gap:read", "intervention:read", "audit:read"],
};

/** Roles that legitimately see records belonging to other people. */
const BROAD_SCOPE_ROLES: PlatformRole[] = ["tenant_admin", "tna_analyst", "manager", "assessor", "auditor"];

export function isSelfScopedOnly(principal: Principal): boolean {
  return !principal.roles.some((role) => BROAD_SCOPE_ROLES.includes(role));
}

export function isOrgInScope(principal: Principal, org: OrgUnit): boolean {
  return org.tenantId === principal.tenantId && principal.delegatedOrgPaths.some((scope) => org.path === scope || org.path.startsWith(`${scope}/`));
}

export function authorize(principal: Principal, action: Action, resource?: { tenantId: string; orgUnit?: OrgUnit; subjectUserId?: string }): void {
  if (resource?.tenantId && resource.tenantId !== principal.tenantId) throw new AuthError(403, "Tenant boundary violation");
  if (!principal.roles.some((role) => roleActions[role].includes(action))) throw new AuthError(403, "Action is not permitted");
  if (resource?.orgUnit && !isOrgInScope(principal, resource.orgUnit)) throw new AuthError(403, "Resource is outside delegated organizational scope");
  // Self-scope applies to any principal holding no role that legitimately grants
  // visibility of other people. Testing role COUNT instead would silently drop
  // the restriction the moment a learner also picked up any second role.
  if (isSelfScopedOnly(principal) && resource?.subjectUserId && resource.subjectUserId !== principal.user.id) {
    throw new AuthError(403, "Learners may only access their own records");
  }
}

export async function currentUserById(userId: string): Promise<User | undefined> {
  return (await readDatabase()).users.find((user) => user.id === userId);
}
