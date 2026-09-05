import { AsyncLocalStorage } from "node:async_hooks";

export type RequestActor = { tenantId: string; userId: string };

/**
 * The validated identity for the current request.
 *
 * PostgreSQL needs a tenant context on every transaction, and `readDatabase()`
 * takes no principal — it is called from thirty-one places that resolve the
 * principal separately. Rather than change all of them mid-cutover, the one
 * function that establishes identity records it here, and the storage layer
 * reads it back.
 *
 * The value is set ONLY from an already-validated session, never from anything
 * a caller supplies. `setTenantContext` in driver.ts rejects a non-uuid, so a
 * forged value cannot become a tenant context; and RLS is enforced by the
 * database regardless, so this decides which tenant is loaded, not whether the
 * boundary holds.
 */
const storage = new AsyncLocalStorage<RequestActor>();

export function rememberActor(actor: RequestActor): void {
  // enterWith binds the value for the remainder of this request's async
  // context. Next.js gives each request its own, so one request's identity
  // cannot leak into another's.
  storage.enterWith(actor);
}

export function currentActor(): RequestActor | undefined {
  return storage.getStore();
}

export function withActor<T>(actor: RequestActor, run: () => Promise<T>): Promise<T> {
  return storage.run(actor, run);
}
