import { asOf, courseTracking, discoverCourses } from "@/lib/server/catalog";
import { principalFromRequest } from "@/lib/server/auth";
import { json, problem, requestId } from "@/lib/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Course discovery, or one course's roster.
 *
 * `?courseId=` switches to tracking rather than living at its own path because
 * the two answers are the same subject seen from two sides, and both are gated
 * by `catalog.ts` itself: discovery needs `course:read` and the delivery
 * visibility rule, tracking needs `course:update` and the caller's delegated
 * roots. Neither check is performed here — a route that re-implemented either
 * would be a second copy of an authorization rule.
 *
 * Read-only, so no CSRF assertion: `assertCsrf` guards state change, and
 * requiring it on a GET would only train callers to send a token they do not
 * need.
 *
 * Nothing in this response is purchasable. `listPriceCents` is an asking price
 * a card may display; there is no order, ledger or charge anywhere behind it,
 * so a client rendering a Buy control against this endpoint would be promising
 * something no code here can do.
 */
export async function GET(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    const params = new URL(request.url).searchParams;

    const courseId = params.get("courseId");
    if (courseId) return json({ ...(await courseTracking(principal, courseId)), asOf: asOf() });

    const items = await discoverCourses(principal, {
      search: params.get("search"),
      skillId: params.get("skillId"),
      sort: params.get("sort"),
    });
    return json({ items, asOf: asOf() });
  } catch (error) {
    return problem(error, rid);
  }
}
