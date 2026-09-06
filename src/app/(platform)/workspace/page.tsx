import Link from "next/link";
import { Badge, Metric, PageHeader, Progress } from "@/components/ui";
import { principalFromCookies } from "@/lib/server/auth";
import { visibleRows } from "@/lib/server/domain-service";
import { requirePersistence, postgresConfigured } from "@/lib/server/persistence";
import { scopeForPrincipal } from "@/lib/server/tenant-runtime";
import { readDatabase } from "@/lib/server/store";

export const dynamic = "force-dynamic";
export const metadata = { title: "Workspace home" };

type HomeData = {
  tenantName: string;
  readinessPercent: number;
  readinessMeasurable: boolean;
  studies: number;
  openGaps: Array<{ id: string; priority: "low" | "medium" | "high" | "critical"; requiredLevel: number; evidencedLevel: number; gap: number; title: string; subject: string; href: string }>;
  activeInterventions: number;
  enrollments: Array<{ id: string; title: string; status: string; progress: number; dueDate: string | null }>;
  notifications: number;
};

async function loadPostgresHome(): Promise<HomeData> {
  const principal = await principalFromCookies();
  const persistence = await requirePersistence();
  return persistence.read(scopeForPrincipal(principal), async (repo) => {
    const [tenant, summary, gaps, interventions, enrollments, notifications] = await Promise.all([
      repo.tenant(),
      repo.readinessSummary(),
      repo.listGapCasesWithContext(),
      repo.listInterventionsInScope(),
      repo.listEnrollmentsWithProgress(),
      repo.listOpenNotifications(),
    ]);
    const openGaps = gaps.filter((item) => item.status !== "verified");
    return {
      tenantName: tenant?.name ?? "This workspace",
      readinessPercent: summary.readinessPercent,
      readinessMeasurable: openGaps.length > 0,
      studies: summary.studies,
      openGaps: openGaps
        .sort((a, b) => b.gap - a.gap || a.id.localeCompare(b.id))
        .slice(0, 6)
        .map((gap) => ({
          id: gap.id,
          priority: gap.priority,
          requiredLevel: gap.requiredLevel,
          evidencedLevel: gap.evidencedLevel,
          gap: gap.gap,
          title: gap.requirement?.sourceReference ?? "Capability requirement",
          subject: gap.subject?.displayName ?? "Learner",
          href: `/studies/${gap.tnaStudyId}/gaps`,
        })),
      activeInterventions: interventions.filter((item) => item.status === "active").length,
      enrollments: enrollments
        .filter((item) => item.status === "enrolled" || item.status === "in_progress")
        .slice(0, 6)
        .map((item) => ({
          id: item.id,
          title: item.course?.title ?? "Learning assignment",
          status: item.status,
          progress: item.progress.percent,
          dueDate: item.dueDate,
        })),
      notifications: notifications.length,
    };
  });
}

async function loadLocalHome(): Promise<HomeData> {
  const principal = await principalFromCookies();
  const database = await readDatabase();
  const gaps = visibleRows(database, principal, "gap:read", database.gapCases).filter((item) => item.status !== "verified");
  const interventions = visibleRows(database, principal, "intervention:read", database.interventions);
  const enrollments = visibleRows(database, principal, "enrollment:read", database.enrollments);
  const notifications = database.notifications.filter((item) => item.tenantId === principal.tenantId && item.resolvedAt === null);
  const required = gaps.reduce((sum, item) => sum + item.requiredLevel, 0);
  const evidenced = gaps.reduce((sum, item) => sum + Math.min(item.evidencedLevel, item.requiredLevel), 0);
  return {
    tenantName: database.tenants.find((item) => item.id === principal.tenantId)?.name ?? "This workspace",
    readinessPercent: required ? Math.round((evidenced / required) * 100) : 100,
    readinessMeasurable: gaps.length > 0,
    studies: visibleRows(database, principal, "tna:read", database.tnaStudies).length,
    openGaps: gaps.slice(0, 6).map((gap) => ({
      id: gap.id,
      priority: gap.priority,
      requiredLevel: gap.requiredLevel,
      evidencedLevel: gap.evidencedLevel,
      gap: gap.gap,
      title: database.requirements.find((item) => item.id === gap.requirementId)?.sourceReference ?? "Capability requirement",
      subject: database.users.find((item) => item.id === gap.subjectUserId)?.displayName ?? "Learner",
      href: `/studies/${gap.tnaStudyId}/gaps`,
    })),
    activeInterventions: interventions.filter((item) => item.status === "active").length,
    enrollments: enrollments.filter((item) => item.status === "enrolled" || item.status === "in_progress").slice(0, 6).map((item) => {
      const modules = database.courseModules.filter((module) => module.courseId === item.courseId && module.required);
      const completed = database.moduleCompletions.filter((completion) => completion.enrollmentId === item.id).length;
      return {
        id: item.id,
        title: database.courses.find((course) => course.id === item.courseId)?.title ?? "Learning assignment",
        status: item.status,
        progress: modules.length ? Math.round((completed / modules.length) * 100) : 0,
        dueDate: item.dueDate,
      };
    }),
    notifications: notifications.length,
  };
}

export default async function WorkspaceHome() {
  const principal = await principalFromCookies();
  const data = postgresConfigured() ? await loadPostgresHome() : await loadLocalHome();
  const isAdmin = principal.roles.includes("tenant_admin");
  const emptyWorkspace = data.studies === 0 && data.openGaps.length === 0 && data.enrollments.length === 0;

  return <div className="page fade-in">
    <PageHeader
      eyebrow={`${data.tenantName} · Learning & Capability`}
      title={emptyWorkspace ? "Build your learning workspace" : "What needs attention now"}
      description={emptyWorkspace
        ? "Your tenant is live. Add your organization and people, then build learning, assessments and capability requirements on top of that foundation."
        : "Learning activity, capability gaps and interventions are brought together here from the tenant's current system of record."}
      actions={isAdmin
        ? <Link className="button primary" href="/admin">Set up tenant</Link>
        : <Link className="button primary" href="/learning">Continue learning</Link>}
    />

    <section className="metrics-grid" aria-label="Workspace summary">
      <Metric label="Readiness" value={data.readinessMeasurable ? `${data.readinessPercent}%` : "Not established"} meta={data.readinessMeasurable ? "Against open capability requirements" : "Create requirements or a TNA study to establish a baseline"} />
      <Metric label="Open gaps" value={`${data.openGaps.length}`} meta="Highest-priority capability gaps currently in scope" />
      <Metric label="Active interventions" value={`${data.activeInterventions}`} meta="Learning, coaching and other actions under way" />
      <Metric label="Notifications" value={`${data.notifications}`} meta="Open items that need attention" />
    </section>

    {emptyWorkspace ? <section className="dashboard-grid lower" aria-label="Tenant onboarding">
      <article className="panel">
        <p className="eyebrow">1 · Foundation</p>
        <h2>Shape the organization</h2>
        <p className="muted">Create departments, campuses or teams and invite the people who will learn, teach, manage and assess.</p>
        <Link className="button secondary" href="/admin">Open tenant administration</Link>
      </article>
      <article className="panel">
        <p className="eyebrow">2 · Learning</p>
        <h2>Start the learning catalogue</h2>
        <p className="muted">Publish the first course and connect it to the skill or outcome it is meant to develop.</p>
        <Link className="button secondary" href="/catalog">Open catalogue</Link>
      </article>
      <article className="panel">
        <p className="eyebrow">3 · Intelligence</p>
        <h2>Establish what people need</h2>
        <p className="muted">Use a TNA study to turn requirements and evidence into a defensible development plan.</p>
        <Link className="button secondary" href="/studies">Open TNA studies</Link>
      </article>
    </section> : <>
      <section className="dashboard-grid">
        <article className="panel">
          <div className="panel-header"><div><p className="eyebrow">Capability</p><h2>Priority gaps</h2></div><Link href="/studies">Open studies</Link></div>
          {data.openGaps.length === 0 ? <p className="muted">No open capability gap is currently in your scope.</p> :
            data.openGaps.map((gap) => <Link className="decision-row" href={gap.href} key={gap.id}>
              <span><strong>{gap.title}</strong><small>{gap.subject} · evidenced {gap.evidencedLevel} of {gap.requiredLevel}</small></span>
              <Badge tone={gap.priority === "critical" ? "danger" : gap.priority === "high" ? "warning" : "neutral"}>{gap.priority} · gap {gap.gap}</Badge>
            </Link>)}
        </article>

        <article className="panel">
          <div className="panel-header"><div><p className="eyebrow">Learning</p><h2>In progress</h2></div><Link href="/learning">Open learning</Link></div>
          {data.enrollments.length === 0 ? <p className="muted">No active learning assignment is currently in your scope.</p> :
            data.enrollments.map((enrollment) => <div className="decision-row" key={enrollment.id}>
              <span><strong>{enrollment.title}</strong><small>{enrollment.status === "in_progress" ? "In progress" : "Not started"}{enrollment.dueDate ? ` · due ${enrollment.dueDate}` : ""}</small></span>
              <div style={{ minWidth: 130 }}><Progress value={enrollment.progress} label={`${enrollment.title} progress`} /></div>
            </div>)}
        </article>
      </section>
    </>}
  </div>;
}
