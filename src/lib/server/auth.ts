import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import type { OrgUnit, PlatformRole, PublicUser, Session, User } from "./domain";
import { withoutSecrets } from "./domain";
import { appendAudit } from "./audit";
import { hashPassword, id, secureToken, verifyPassword } from "./security";
import { mutateDatabase, readDatabase } from "./store";
import { rememberActor } from "./request-context";
import { csrfMatches, scopeFromPrincipal } from "./db/postgres";
import { toStorageId } from "./db/ids";
import type { ActorScope, OsaPersistence, SessionRef } from "./db/repository";

export { SESSION_COOKIE } from "./session-cookie";
import { SESSION_COOKIE, secureAttribute } from "./session-cookie";
const SESSION_HOURS = 12;
const MAX_SESSIONS_PER_USER = 5;

/**
 * Per-process login throttle.
 *
 * It counts FAILURES, and it counts them after the credential has been checked.
 * The previous version counted every ATTEMPT before checking anything and threw
 * once the counter passed the limit, so ten wrong guesses locked the account for
 * fifteen minutes — and the owner's correct password was refused along with the
 * attacker's wrong ones. `clearThrottle` only ran after a successful login,
 * which that throw had made unreachable, so nothing but the window expiring
 * could release it. Anyone who knew an address could deny its owner service,
 * which is a worse outcome than the online guessing it was meant to slow.
 *
 * The rule now is: a correct credential always authenticates. Guessing is
 * slowed instead of stopped, with a bounded, escalating delay on the failure
 * response once the limit is passed; the delay costs an attacker a serial round
 * trip per guess and costs a legitimate user nothing, because a legitimate user
 * is not on the failure path. A success clears the counter outright.
 *
 * The key is the address alone. Including the tenant slug, as the previous
 * version did, let an attacker reset their own counter by varying a field they
 * control — and now that the counter is the only brake left, that bypass is no
 * longer affordable.
 *
 * Honest limitation, unchanged: this is in-memory, so it protects a single
 * instance only - the same constraint the JSON datastore already imposes. It
 * must move to a shared store alongside the PostgreSQL migration; see
 * README-migration.md §5 and ADR-002.
 */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_BACKOFF_BASE_MS = 200;
const LOGIN_BACKOFF_MAX_MS = 2_000;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

function throttleKeyFor(email: string): string {
  return email.trim().toLowerCase();
}

/** Records one failed sign-in and returns the failures on record in this window. */
function recordFailedLogin(key: string): number {
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || entry.resetAt <= now) {
    loginAttempts.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

function clearThrottle(key: string): void {
  loginAttempts.delete(key);
}

/** Doubles per failure past the limit and then stops; never unbounded. */
function backoffFor(failures: number): number {
  if (failures <= LOGIN_MAX_ATTEMPTS) return 0;
  const steps = Math.min(failures - LOGIN_MAX_ATTEMPTS - 1, 10);
  return Math.min(LOGIN_BACKOFF_BASE_MS * 2 ** steps, LOGIN_BACKOFF_MAX_MS);
}

/**
 * The single exit for a rejected credential, shared by both datastores.
 *
 * Called only once the password has actually been evaluated and the failure
 * audited, so the counter measures failures rather than traffic. The message
 * changes past the limit — the caller has already failed either way, so this
 * discloses nothing about the account and tells an operator reading the ledger
 * that the brake engaged.
 */
async function refuseLogin(key: string): Promise<never> {
  const delay = backoffFor(recordFailedLogin(key));
  if (delay === 0) throw new AuthError(401, "Invalid credentials");
  await new Promise((resolve) => setTimeout(resolve, delay));
  throw new AuthError(401, "Too many sign-in attempts. Try again later.");
}

/** Same scrypt cost as a real credential, so a failed lookup is indistinguishable. */
const DECOY_PASSWORD_HASH = hashPassword("decoy-credential-never-matches");

/* ---------------------------------------------------------------------------
 * The datastore seam
 *
 * `DATABASE_URL` decides which datastore is authoritative, and the two are
 * never both consulted for one request: when it is set PostgreSQL is the system
 * of record and nothing below reaches `store.ts`; when it is absent the JSON
 * store serves local development and the unit suite exactly as before.
 *
 * `persistence.ts` is imported lazily, and only after the environment switch
 * has already been read. That is deliberate: it imports "server-only", which
 * throws under a plain Node module loader, so a static import here would take
 * every JSON-path unit test down with it. The lazy import also keeps the whole
 * PostgreSQL adapter out of the JSON path's module graph.
 * ------------------------------------------------------------------------- */

async function postgres(): Promise<OsaPersistence | null> {
  if (!process.env.DATABASE_URL) return null;
  const { postgresConfigured, requirePersistence } = await import("./persistence");
  return postgresConfigured() ? requirePersistence() : null;
}

/**
 * The actor context for a transaction that has not yet authenticated anybody.
 *
 * `withTenantTransaction` requires `app.user_id` to be a uuid, and the email
 * lookup at login runs before a user exists. No RLS policy in `001` reads
 * `app.user_id` — every policy is `tenant_id = osa.current_tenant_id()` — so
 * the nil uuid is an honest "no actor established", not a widened scope. The
 * tenant context is real and is what confines the query.
 */
const NIL_ACTOR = "00000000-0000-0000-0000-000000000000";

/** Tenant-scoped, actor-less: enough for `findUserByEmail` and a failure audit. */
function preAuthScope(tenantId: string): ActorScope {
  return { tenantId: toStorageId(tenantId), userId: NIL_ACTOR, orgScopes: [], viewerOrgPath: "", selfOnly: false };
}

/**
 * The scope for the session and audit writes belonging to one authenticated
 * user. `osa.sessions` and `osa.audit_events` are keyed on tenant and user
 * alone, so `orgScopes` / `viewerOrgPath` are not read on this path;
 * `viewerOrgPath` is the delegated root because neither `findUserByEmail` nor
 * `loadPrincipal` returns the user's own org-unit path, and adding that to
 * `OsaRepository` is a change to a file this work does not own.
 */
function actorScope(user: User): ActorScope {
  return scopeFromPrincipal({
    tenantId: user.tenantId,
    user: { id: user.id, orgUnitId: user.orgUnitId },
    delegatedOrgPaths: user.delegatedOrgPaths,
    selfOnly: !user.roles.some((role) => BROAD_SCOPE_ROLES.includes(role)),
    viewerOrgPath: user.delegatedOrgPaths[0] ?? "",
  });
}

/** A resolved session, before the principal behind it has been loaded. */
function sessionScope(reference: SessionRef): ActorScope {
  return { tenantId: reference.tenantId, userId: reference.userId, orgScopes: [], viewerOrgPath: "", selfOnly: false };
}

/* ---------------------------------------------------------------------------
 * CSRF tokens under a schema that stores only their digest
 *
 * `osa.sessions.csrf_hash` is `bytea`: SHA-256 of the token and nothing more.
 * That is the right storage decision — a datastore compromise yields no usable
 * token — but it removes the assumption the JSON store was built on, that the
 * raw token can be read back on a later request. `Principal.session.csrfToken`
 * is passed into client components as a prop by five pages and returned by
 * `GET /api/auth/session`, so it has to be populated on every request, not just
 * on the one that minted the session.
 *
 * Storing the token in a second cookie, or in the session cookie's value, would
 * make it recoverable but would also hand it to anything that can read the
 * cookie jar. Instead the token is DERIVED:
 *
 *     csrfToken = HMAC-SHA256(AUTH_SECRET, "csrf:v1:" || rawSessionToken)
 *
 * so it is recomputable on any request that presents the cookie, and only by
 * this server:
 *
 *   * The raw session token exists in exactly one place, the HttpOnly cookie.
 *     The database holds only its SHA-256, so a database compromise still
 *     yields neither a usable cookie nor a usable CSRF token.
 *   * HMAC is one-way, so the CSRF token — which is deliberately readable by
 *     the page's own JavaScript — never leaks the session token back.
 *   * It is unpredictable without `AUTH_SECRET`, which is what a synchronizer
 *     token has to be.
 *
 * The derivation alone is not trusted. `resolvePrincipal` verifies the derived
 * token against the stored `csrf_hash` with `csrfMatches` before putting it on
 * the Principal, so a token minted under a rotated `AUTH_SECRET` fails closed
 * (the session is rejected and the person signs in again) rather than being
 * silently accepted against a row it does not match.
 *
 * The JSON store keeps its own random per-session token, unchanged. Both
 * backends therefore hand `assertCsrf` a raw token to compare, which is why
 * that function keeps its exact signature and stays synchronous.
 * ------------------------------------------------------------------------- */

const CSRF_DEVELOPMENT_SECRET = "development-auth-secret-replace-me";

function csrfSecret(): string {
  const secret = process.env.AUTH_SECRET;
  if (secret && secret.length > 0) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET must be configured before sessions can be issued in production");
  }
  return CSRF_DEVELOPMENT_SECRET;
}

function deriveCsrfToken(sessionToken: string): string {
  return createHmac("sha256", csrfSecret()).update(`csrf:v1:${sessionToken}`).digest("base64url");
}

/** Constant-time string comparison; length is not secret, contents are. */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

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
  // No pre-check: the credential is evaluated first, and only a FAILURE reaches
  // the throttle. See the note on `refuseLogin`.
  const throttleKey = throttleKeyFor(email);
  const store = await postgres();
  if (store) return loginWithPostgres(store, email, password, requestId, tenantSlug, throttleKey);
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
    return refuseLogin(throttleKey);
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

/**
 * Tenant-first login.
 *
 * `findTenantBySlug` is the one query that runs with no tenant context —
 * `osa.tenants` is the single table `001` leaves outside the RLS array — and
 * everything after it runs inside that tenant's context. The email lookup never
 * happens across tenants, which is the RLS escape README-migration.md §5 warns
 * about, so a slug is genuinely required.
 *
 * The login form does not send one and is not this work's file to change, so
 * the slug is resolved in this order:
 *
 *   1. the `tenantSlug` argument (`POST /api/auth/login` already forwards it);
 *   2. `DEFAULT_TENANT_SLUG`, the deployment's home workspace;
 *   3. otherwise refuse, with the message the JSON path already uses when an
 *      address is ambiguous across tenants.
 *
 * The JSON store's "emails happen to be unique across tenants, so scan them
 * all" is NOT reproduced. It only works because the whole table is readable in
 * one process, and reproducing it here would mean either querying users with no
 * tenant context or enumerating every tenant and probing each in turn —
 * the first is the escape, the second turns one login into one query per
 * tenant on an unauthenticated endpoint. Refusing is the honest answer, and it
 * is the change README-migration.md §5 asks for.
 */
async function loginWithPostgres(
  store: OsaPersistence,
  email: string,
  password: string,
  requestId: string,
  tenantSlug: string | undefined,
  throttleKey: string,
): Promise<{ session: Session; user: PublicUser }> {
  // `||`, not `??`: an empty `tenantSlug` in the request body is an absent one,
  // and must still fall through to the deployment's configured workspace.
  const slug = (tenantSlug?.trim() || process.env.DEFAULT_TENANT_SLUG?.trim() || "").toLowerCase();
  if (!slug) {
    verifyPassword(password, DECOY_PASSWORD_HASH);
    throw new AuthError(401, "Tenant selection required");
  }

  const tenant = await store.findTenantBySlug(slug);
  const user = tenant ? await store.read(preAuthScope(tenant.id), (repo) => repo.findUserByEmail(email)) : null;

  // Timing equalisation, exactly as on the JSON path: an unknown address, an
  // unknown workspace and a wrong password all cost one scrypt derivation.
  const passwordMatches = user
    ? verifyPassword(password, user.passwordHash)
    : (verifyPassword(password, DECOY_PASSWORD_HASH), false);

  if (!user || !user.active || !passwordMatches) {
    // Failures are audited even when the account does not exist, provided the
    // workspace does — an unknown slug has no chain to append to, which is the
    // same rule the JSON path applies to an unknown `matchingTenantId`.
    //
    // `findUserByEmail` filters `AND u.active` in SQL, so a deactivated account
    // is indistinguishable from an unknown one here and audits as
    // `unknown_account`. Recovering `account_inactive` needs a repository
    // method that returns inactive users, which this work does not own.
    if (tenant) {
      await store.write(user ? actorScope(user) : preAuthScope(tenant.id), (repo) => repo.appendAudit({
        actorUserId: user?.id ?? null,
        action: "auth.login",
        resourceType: "session",
        resourceId: null,
        outcome: "failure",
        requestId,
        // No email or password material: the ledger is readable by auditors.
        metadata: { reason: user ? (user.active ? "invalid_credentials" : "account_inactive") : "unknown_account" },
      }));
    }
    return refuseLogin(throttleKey);
  }

  const issuedAt = new Date();
  const sessionToken = secureToken();
  const session: Session = {
    id: sessionToken,
    userId: user.id,
    tenantId: user.tenantId,
    csrfToken: deriveCsrfToken(sessionToken),
    createdAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + SESSION_HOURS * 60 * 60 * 1000).toISOString(),
  };

  // One transaction: the session row and its ledger entry land together or
  // neither does. `createSession` stores only SHA-256 of each token.
  //
  // MAX_SESSIONS_PER_USER is NOT enforced here, and that is a reported gap
  // rather than an oversight. `OsaRepository` exposes `deleteSession(token)`
  // and `deleteSessionsForUser(userId)` and nothing between them, and the
  // stored tokens are digests, so the newest few cannot be identified and kept.
  // The only reachable behaviour is the all-or-nothing eviction the JSON path's
  // comment explicitly rejects (signing in on a phone would sign you out of the
  // tablet). Capping needs one method on `OsaRepository` — for example
  // `pruneSessions(userId, keepNewest)`, ordering by `created_at` and deleting
  // the tail — which is a change to a file this work does not own. Expiry needs
  // nothing: `osa.resolve_session` already refuses rows past `expires_at`.
  await store.write(actorScope(user), async (repo) => {
    await repo.createSession({ sessionToken, csrfToken: session.csrfToken, expiresAt: session.expiresAt });
    await repo.appendAudit({
      actorUserId: user.id,
      action: "auth.login",
      resourceType: "session",
      resourceId: sessionToken.slice(0, 12),
      outcome: "success",
      requestId,
    });
  });

  clearThrottle(throttleKey);
  return { session, user: withoutSecrets(user) };
}

export async function logout(request: Request, requestId: string): Promise<void> {
  const token = cookieValue(request, SESSION_COOKIE);
  if (!token) return;
  const store = await postgres();
  if (store) {
    // `resolveSession` is the only way back from an opaque cookie to a tenant,
    // and `deleteSession` needs that tenant context. A session that no longer
    // resolves — expired, already deleted, never issued — is a no-op with no
    // ledger entry, which is what the JSON path does for an unknown token.
    const reference = await store.resolveSession(token);
    if (!reference) return;
    await store.write(sessionScope(reference), async (repo) => {
      await repo.deleteSession(token);
      await repo.appendAudit({
        actorUserId: reference.userId,
        action: "auth.logout",
        resourceType: "session",
        resourceId: token.slice(0, 12),
        outcome: "success",
        requestId,
      });
    });
    return;
  }
  const database = await readDatabase();
  const session = database.sessions.find((candidate) => candidate.id === token);
  await mutateDatabase((state) => { state.sessions = state.sessions.filter((candidate) => candidate.id !== token); });
  if (session) await appendAudit({ tenantId: session.tenantId, actorUserId: session.userId, action: "auth.logout", resourceType: "session", resourceId: session.id.slice(0, 12), outcome: "success", requestId });
}

export async function resolvePrincipal(token: string | null): Promise<Principal> {
  if (!token) throw new AuthError(401, "Authentication required");
  const store = await postgres();
  if (store) {
    const principal = await resolvePrincipalWithPostgres(store, token);
    // Record the validated identity so the storage layer can open a tenant
    // context without every caller threading a principal through to it.
    rememberActor({ tenantId: principal.tenantId, userId: principal.user.id });
    return principal;
  }
  const database = await readDatabase();
  const session = database.sessions.find((candidate) => candidate.id === token);
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) throw new AuthError(401, "Session expired");
  const user = database.users.find((candidate) => candidate.id === session.userId && candidate.tenantId === session.tenantId && candidate.active);
  if (!user) throw new AuthError(401, "Account is unavailable");
  return { session, user: withoutSecrets(user), tenantId: session.tenantId, roles: user.roles, delegatedOrgPaths: user.delegatedOrgPaths };
}

/**
 * Session resolution is the one operation that cannot be tenant-scoped first:
 * the cookie carries an opaque token and nothing else. `resolveSession` goes
 * through `osa.resolve_session`, the STABLE `SECURITY DEFINER` function owned
 * by the NOLOGIN `ik_osa_session_resolver` role — the only sanctioned RLS
 * escape in the system, and one that returns four columns of one row keyed by a
 * digest. Everything after this line runs inside the tenant context it yields.
 */
async function resolvePrincipalWithPostgres(store: OsaPersistence, token: string): Promise<Principal> {
  const reference = await store.resolveSession(token);
  // The function already filters `revoked_at IS NULL AND expires_at > now()`,
  // so an expired session is indistinguishable from an absent one, as here.
  if (!reference) throw new AuthError(401, "Session expired");

  // Re-derive the CSRF token from the cookie and prove it against the digest
  // the row actually holds. A session issued under a rotated AUTH_SECRET fails
  // here rather than being carried forward with a token that would never match.
  const csrfToken = deriveCsrfToken(token);
  if (!csrfMatches(csrfToken, reference.csrfHash)) throw new AuthError(401, "Session expired");

  const record = await store.read(sessionScope(reference), (repo) => repo.loadPrincipal(reference.userId));
  if (!record) throw new AuthError(401, "Account is unavailable");

  const session: Session = {
    id: token,
    userId: reference.userId,
    tenantId: reference.tenantId,
    csrfToken,
    // `osa.resolve_session` returns four columns and `created_at` is not one of
    // them. Every session this module issues expires exactly SESSION_HOURS
    // after it was created, so the origin is recoverable from the expiry
    // without widening the one RLS escape in the system to carry a field
    // nothing reads.
    createdAt: new Date(Date.parse(reference.expiresAt) - SESSION_HOURS * 60 * 60 * 1000).toISOString(),
    expiresAt: reference.expiresAt,
  };
  return {
    session,
    user: withoutSecrets(record.user),
    tenantId: reference.tenantId,
    roles: record.roles,
    delegatedOrgPaths: record.delegatedOrgPaths,
  };
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

/**
 * Both backends put a raw token on the Principal — random on the JSON path,
 * derived and already verified against `csrf_hash` on the PostgreSQL one — so
 * this stays a synchronous comparison with no datastore round trip. The
 * comparison is constant-time; the previous `!==` leaked the length of the
 * matching prefix to anyone able to time the endpoint.
 */
export function assertCsrf(request: Request, principal: Principal): void {
  const presented = request.headers.get("x-csrf-token");
  if (!presented || !tokensMatch(presented, principal.session.csrfToken)) throw new AuthError(403, "Invalid CSRF token");
}

export function serializeSessionCookie(session: Session, request: Request): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_HOURS * 3600}${secureAttribute(request)}`;
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

/**
 * JSON-path only, and currently called by nothing in `src/`.
 *
 * A bare user id carries no tenant, and every PostgreSQL read needs a tenant
 * context before it touches `osa.users`, so this cannot be answered against the
 * database as written — `loadPrincipal` takes a scope for exactly that reason.
 * It refuses rather than quietly reading the JSON store while PostgreSQL is the
 * system of record: silently answering from the wrong datastore is the failure
 * the seam exists to prevent. Callers that appear later should resolve the user
 * through the principal they already hold.
 */
export async function currentUserById(userId: string): Promise<User | undefined> {
  if (process.env.DATABASE_URL) {
    throw new Error("currentUserById cannot be resolved without a tenant context; load the user through the request's principal.");
  }
  return (await readDatabase()).users.find((user) => user.id === userId);
}
