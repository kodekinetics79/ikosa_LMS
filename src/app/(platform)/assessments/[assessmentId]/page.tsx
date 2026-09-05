import { notFound, redirect } from "next/navigation";
import { principalFromCookies } from "@/lib/server/auth";
import { assessmentDetail } from "@/lib/server/assessment/authoring";
import { listAuthorQuestions } from "@/lib/server/assessment-list-store";
import { RuleError } from "@/lib/server/errors";
import { AssessmentBuilderClient } from "./builder-client";

export const metadata = { title: "Assessment builder" };
export const dynamic = "force-dynamic";

/**
 * The authoring view of one assessment.
 *
 * Author-only. `assessmentDetail` enforces both the role and the delegated
 * organizational scope, so a learner reaching this URL gets the same refusal
 * the API gives them rather than a page that renders and then fails.
 */
export default async function AssessmentBuilderPage({ params }: { params: Promise<{ assessmentId: string }> }) {
  const { assessmentId } = await params;
  let principal;
  try {
    principal = await principalFromCookies();
  } catch {
    redirect(`/login?next=/assessments/${assessmentId}`);
  }

  try {
    const [detail, questions] = await Promise.all([
      assessmentDetail(principal, assessmentId),
      listAuthorQuestions(principal),
    ]);
    return <AssessmentBuilderClient detail={detail} questions={questions} csrfToken={principal.session.csrfToken} />;
  } catch (error) {
    // A learner or a marker has no builder. Sending them to the workspace is
    // more useful than a 404 they cannot act on.
    if (error instanceof RuleError && error.status === 403) redirect("/assessments");
    if (error instanceof RuleError && error.status === 404) notFound();
    throw error;
  }
}
