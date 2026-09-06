import { redirect } from "next/navigation";
import { principalFromCookies } from "@/lib/server/auth";
import { AssessmentAttemptClient } from "./assessment-attempt-client";

export const metadata = { title: "Assessment attempt" };
export const dynamic = "force-dynamic";

export default async function AssessmentAttemptPage({ params }: { params: Promise<{ assessmentId: string }> }) {
  const { assessmentId } = await params;
  try {
    const principal = await principalFromCookies();
    if (!principal.roles.includes("learner")) redirect("/assessments");
    return <AssessmentAttemptClient assessmentId={assessmentId} csrfToken={principal.session.csrfToken} />;
  } catch {
    redirect(`/login?next=/assessments/${encodeURIComponent(assessmentId)}/attempt`);
  }
}
