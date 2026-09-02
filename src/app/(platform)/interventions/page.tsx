import Link from "next/link";
import { Badge, PageHeader } from "@/components/ui";
import type { Enrollment, GapCase, Intervention } from "@/lib/server/domain";
import { principalFromCookies } from "@/lib/server/auth";
import { visibleRows } from "@/lib/server/domain-service";
import { readDatabase } from "@/lib/server/store";

export const metadata = { title: "Interventions" };

const typeLabel: Record<Intervention["type"], string> = {
  learning: "Learning",
  coaching: "Coaching",
  job_aid: "Job aid",
  process: "Process change",
  tooling: "Tooling",
  staffing: "Staffing",
};

const statusLabel: Record<Intervention["status"], string> = {
  planned: "Planned",
  active: "Active",
  completed: "Completed",
  verified: "Verified",
};

const statusTone = { planned: "neutral", active: "info", completed: "success", verified: "success" } as const;

const priorityLabel: Record<GapCase["priority"], string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const priorityRank: Record<GapCase["priority"], number> = { critical: 0, high: 1, medium: 2, low: 3 };

/**
 * Fulfilment stated from the enrollment ledger only.
 *
 * Evidence is counted separately from completion because they are not the same
 * claim: an attendance-only course completes without ever evidencing competence,
 * and a failed assessment leaves an enrollment open. Collapsing the two would
 * report a gap as being closed by learning that closed nothing.
 */
function fulfilment(assigned: Enrollment[], evidenced: number): string {
  if (assigned.length === 0) return "No course assigned yet";
  const parts = [`${assigned.length} assigned`];
  const notStarted = assigned.filter((row) => row.status === "enrolled").length;
  const inProgress = assigned.filter((row) => row.status === "in_progress").length;
  const completed = assigned.filter((row) => row.status === "completed").length;
  const withdrawn = assigned.filter((row) => row.status === "withdrawn").length;
  if (notStarted) parts.push(`${notStarted} not started`);
  if (inProgress) parts.push(`${inProgress} in progress`);
  if (completed) parts.push(`${completed} completed`);
  if (withdrawn) parts.push(`${withdrawn} withdrawn`);
  parts.push(evidenced ? `${evidenced} emitted evidence` : "no evidence emitted");
  return parts.join(" · ");
}

export default async function Interventions() {
  const principal = await principalFromCookies();
  const db = await readDatabase();

  const interventions = visibleRows(db, principal, "intervention:read", db.interventions);
  const enrollments = visibleRows(db, principal, "enrollment:read", db.enrollments);
  const today = new Date().toISOString().slice(0, 10);

  const rows = interventions.map((intervention) => {
    const record = db.gapCases.find((candidate) => candidate.id === intervention.gapCaseId && candidate.tenantId === principal.tenantId);
    // An intervention is scoped to an organizational unit; the gap case behind it
    // names a person. Re-checking the gap separately stops a unit-wide reader
    // from learning who is short of a requirement through the action register.
    const gap = record && visibleRows(db, principal, "gap:read", [record]).length === 1 ? record : undefined;
    const requirement = gap ? db.requirements.find((candidate) => candidate.id === gap.requirementId) : undefined;
    const skill = requirement ? db.skills.find((candidate) => candidate.id === requirement.skillId) : undefined;
    const subject = gap ? db.users.find((candidate) => candidate.id === gap.subjectUserId) : undefined;
    const owner = db.users.find((candidate) => candidate.id === intervention.ownerUserId);
    const assigned = intervention.type === "learning" ? enrollments.filter((row) => row.interventionId === intervention.id) : [];
    const evidenced = assigned.filter((row) => row.evidenceId && db.evidence.some((item) => item.id === row.evidenceId && item.status === "verified")).length;
    const open = intervention.status !== "completed" && intervention.status !== "verified";
    return {
      intervention,
      gap,
      skill,
      subject,
      owner,
      assigned,
      evidenced,
      overdue: open && intervention.dueDate < today,
    };
  });

  rows.sort((a, b) =>
    Number(b.overdue) - Number(a.overdue) ||
    (a.gap ? priorityRank[a.gap.priority] : 4) - (b.gap ? priorityRank[b.gap.priority] : 4) ||
    a.intervention.dueDate.localeCompare(b.intervention.dueDate) ||
    a.intervention.title.localeCompare(b.intervention.title));

  const overdue = rows.filter((row) => row.overdue).length;
  const awaiting = rows.filter((row) => row.intervention.type === "learning" && row.assigned.length === 0).length;

  return (
    <div className="page fade-in">
      <PageHeader
        eyebrow="Action register"
        title="Intervention scenarios"
        description="Every action planned against a diagnosed gap, ordered by what is late, and what each one has actually delivered so far."
      />

      <section className="panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Recorded interventions</p>
            <h2>In your delegated scope</h2>
          </div>
          <span className="count-badge">{rows.length}</span>
        </div>

        {rows.length === 0 ? (
          <p className="muted">
            No interventions are recorded in your delegated scope. An intervention is created against a diagnosed gap
            in a TNA study, so nothing appears here until a gap has been triaged into an action.
          </p>
        ) : (
          <>
            <div className="record-list">
              {rows.map(({ intervention, gap, skill, subject, owner, assigned, evidenced, overdue: late }) => (
                <Link key={intervention.id} href={`/interventions/${intervention.id}`} className="record-row">
                  <span className={`severity-mark severity-mark--${gap?.priority ?? "low"}`} aria-hidden="true" />
                  <div className="record-main">
                    <strong>{intervention.title}</strong>
                    <span className="record-meta">
                      <span>{typeLabel[intervention.type]}</span>
                      {gap && skill ? (
                        <span>{skill.name} · required {gap.requiredLevel}, evidenced {gap.evidencedLevel}</span>
                      ) : (
                        <span>Gap case outside your scope</span>
                      )}
                      {subject && <span>{subject.displayName}</span>}
                      {gap && <span>{priorityLabel[gap.priority]} priority gap</span>}
                      <span>Owner {owner?.displayName ?? "unassigned"}</span>
                    </span>
                    <span className="record-meta">
                      {intervention.type === "learning" ? (
                        <span>{fulfilment(assigned, evidenced)}</span>
                      ) : (
                        <span>Not a course · closure needs separately recorded evidence</span>
                      )}
                    </span>
                  </div>
                  <div className="record-side">
                    <Badge tone={late ? "danger" : statusTone[intervention.status]}>
                      {late ? `Overdue · ${statusLabel[intervention.status]}` : statusLabel[intervention.status]}
                    </Badge>
                    <small>Due {intervention.dueDate}</small>
                  </div>
                </Link>
              ))}
            </div>

            <div className="stat-strip">
              <div><span>Interventions in scope</span><strong>{rows.length}</strong></div>
              <div><span>Past their due date</span><strong>{overdue}</strong></div>
              <div><span>Learning with no course assigned</span><strong>{awaiting}</strong></div>
            </div>
            <p className="inline-note">
              Counts describe the records you are authorized to see. Fulfilment is read from enrollments; nothing here is
              estimated, scored or ranked by a model.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
