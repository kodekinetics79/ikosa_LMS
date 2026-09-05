import { redirect } from "next/navigation";
import { principalFromCookies } from "@/lib/server/auth";
import { listMarkingQueue } from "@/lib/server/assessment-list-store";
import { canGradeAssessments } from "@/lib/server/assessment/runtime";
import { MarkingClient } from "./marking-client";

export const metadata = { title: "Marking" };
export const dynamic = "force-dynamic";

/**
 * The marker's own screen.
 *
 * The workspace's marking tab lists loose responses; this page works an attempt
 * at a time so a mark is awarded with the rest of the script in view.
 *
 * The role is checked here as well as in the API because a page that renders
 * and then fails every fetch is worse than a redirect: the marker cannot tell a
 * permission problem from an outage. `canGradeAssessments` is the shared
 * predicate, so this gate cannot drift from the one the queue and the grade
 * write use.
 */
export default async function MarkingPage() {
  let principal;
  try {
    principal = await principalFromCookies();
  } catch {
    redirect("/login?next=/assessments/marking");
  }

  // A learner reaching this URL gets the workspace they do have, not a 403 page
  // they cannot act on.
  if (!canGradeAssessments(principal)) redirect("/assessments");

  const queue = await listMarkingQueue(principal);
  return <MarkingClient queue={queue} csrfToken={principal.session.csrfToken} />;
}
