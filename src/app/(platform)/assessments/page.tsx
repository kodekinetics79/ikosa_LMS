import { redirect } from "next/navigation";
import { principalFromCookies } from "@/lib/server/auth";
import { assessmentCapabilities, listQuestionBanks } from "@/lib/server/assessment-store";
import { listAssessmentWorkspace, listAuthorQuestions, listMarkingQueue } from "@/lib/server/assessment-list-store";
import { tenantShellContext } from "@/lib/server/tenant-runtime";
import { AssessmentWorkspaceClient } from "./assessment-workspace-client";

export const metadata = { title: "Assessments" };
export const dynamic = "force-dynamic";

export default async function AssessmentsPage() {
  try {
    const principal = await principalFromCookies();
    const capabilities = assessmentCapabilities(principal);
    const [assessments, shell, banks, questions, marking] = await Promise.all([
      listAssessmentWorkspace(principal),
      tenantShellContext(principal),
      capabilities.author ? listQuestionBanks(principal) : Promise.resolve([]),
      capabilities.author ? listAuthorQuestions(principal) : Promise.resolve([]),
      capabilities.grader ? listMarkingQueue(principal) : Promise.resolve([]),
    ]);

    return (
      <AssessmentWorkspaceClient
        assessments={assessments}
        banks={banks}
        questions={questions}
        marking={marking}
        organizations={shell.organizations}
        capabilities={capabilities}
        csrfToken={principal.session.csrfToken}
      />
    );
  } catch {
    redirect("/login?next=/assessments");
  }
}
