import { redirect } from "next/navigation";
import { principalFromCookies } from "@/lib/server/auth";
import { tenantShellContext } from "@/lib/server/tenant-runtime";
import { SessionsClient } from "./sessions-client";

export const metadata = { title: "Live sessions" };
export const dynamic = "force-dynamic";

/**
 * Scheduled sessions and the attendance recorded against them.
 *
 * Only the identity and the organization list are resolved here. The session
 * list is loaded by the client from `/api/live-sessions` so that creating,
 * cancelling or recording attendance refreshes what is on screen from the
 * server rather than from optimistic local state — an attendance record that
 * only exists in the browser is exactly the kind of "evidence" this product
 * must never show.
 *
 * `organizations` comes from `tenantShellContext`, which resolves the scope the
 * signed-in principal actually holds, so the scheduler's organization picker
 * cannot offer a unit the API would then refuse.
 */
export default async function SessionsPage() {
  let principal;
  try {
    principal = await principalFromCookies();
  } catch {
    redirect("/login?next=/sessions");
  }

  const { organizations } = await tenantShellContext(principal);
  return (
    <SessionsClient
      roles={principal.roles}
      organizations={organizations}
      csrfToken={principal.session.csrfToken}
    />
  );
}
