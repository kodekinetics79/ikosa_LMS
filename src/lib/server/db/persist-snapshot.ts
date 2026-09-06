import type { Queryable } from "./driver";
import type { Database } from "../domain";
import type { OsaRepository } from "./repository";
import * as w from "./write-mapping";
import { toStorageId } from "./ids";

/**
 * Writes back what a mutation changed in a snapshot.
 *
 * `mutateDatabase(fn)` hands callers the whole database, lets them mutate it,
 * and persists the result. Fourteen call sites depend on that shape. Rather
 * than rewrite them during a datastore cutover, this diffs the snapshot before
 * and after and emits only the rows that actually changed.
 *
 * It runs inside the caller's transaction, so the domain change and its ledger
 * entry commit together or not at all.
 *
 * The honest cost, stated plainly: this is a read-modify-write over a tenant's
 * working set. It is correct under concurrency only because the caller holds a
 * transaction-scoped advisory lock on the tenant, which serialises writers the
 * way the old single-process write queue did — but across instances, which the
 * file store never could. It is not how a large tenant should write one row.
 * `OsaRepository` already exposes targeted writes (`insertEvidence`,
 * `completeModule`, `triageSignal`, …) and each call site should move onto them.
 */

type Row = Record<string, unknown>;

/** A table that can be diffed generically: same id, same shape, deletable. */
type TableSpec<T extends { id: string }> = {
  table: string;
  rows: (database: Database) => readonly T[];
  toRow: (item: T, database: Database, actorId: string) => Row | null;
  /** Junction rows keyed off the parent, replaced wholesale when the parent changes. */
  junctions?: Array<{ table: string; parentColumn: string; toRows: (item: T) => Row[] }>;
  /** Append-only tables refuse UPDATE and DELETE at the trigger level. */
  appendOnly?: boolean;
};

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  return new Map(items.map((item) => [item.id, item]));
}

/**
 * `conflictTarget` is "(id)" for a table with a surrogate key and "" for a
 * junction table, which has none. Emitting `ON CONFLICT (id)` unconditionally
 * meant every write that touched a junction — creating a TNA study with target
 * roles, saving a signal's skills, changing a user's roles — failed with
 * `column "id" does not exist`. The bare `ON CONFLICT DO NOTHING` matches any
 * unique constraint the table does have.
 */
async function insert(db: Queryable, table: string, row: Row, conflictTarget = "(id)"): Promise<void> {
  const columns = Object.keys(row);
  const values = columns.map((column) => row[column]);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  const target = conflictTarget ? `${conflictTarget} ` : "";
  await db.query(
    `INSERT INTO osa.${table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")}) ON CONFLICT ${target}DO NOTHING`,
    values,
  );
}

async function update(db: Queryable, table: string, row: Row): Promise<void> {
  const columns = Object.keys(row).filter((column) => column !== "id");
  if (columns.length === 0) return;
  const assignments = columns.map((column, index) => `${column} = $${index + 2}`);
  await db.query(
    `UPDATE osa.${table} SET ${assignments.join(", ")} WHERE id = $1`,
    [row.id, ...columns.map((column) => row[column])],
  );
}

function courseIdFor(database: Database, enrollmentId: string): string {
  const enrollment = database.enrollments.find((candidate) => candidate.id === enrollmentId);
  return enrollment?.courseId ?? "";
}

function specs(actorId: string): TableSpec<{ id: string }>[] {
  const spec = <T extends { id: string }>(value: TableSpec<T>) => value as unknown as TableSpec<{ id: string }>;
  return [
    spec({ table: "tenants", rows: (d) => d.tenants, toRow: (t) => w.fromTenant(t) }),
    spec({ table: "org_units", rows: (d) => d.orgUnits, toRow: (u) => w.fromOrgUnit(u) }),
    spec({
      table: "users",
      rows: (d) => d.users,
      toRow: (u) => w.fromUser(u),
      junctions: [{ table: "user_roles", parentColumn: "user_id", toRows: (u) => w.fromUserRoles(u) }],
    }),
    spec({ table: "skills", rows: (d) => d.skills, toRow: (s) => w.fromSkill(s) }),
    spec({ table: "job_roles", rows: (d) => d.jobRoles, toRow: (r) => w.fromJobRole(r, actorId) }),
    spec({ table: "requirements", rows: (d) => d.requirements, toRow: (r) => w.fromRequirement(r, actorId) }),
    spec({
      table: "tna_studies",
      rows: (d) => d.tnaStudies,
      toRow: (s) => w.fromStudy(s),
      junctions: [{ table: "tna_target_roles", parentColumn: "tna_study_id", toRows: (s) => w.fromStudyTargetRoles(s) }],
    }),
    spec({ table: "evidence", rows: (d) => d.evidence, toRow: (e) => w.fromEvidence(e) }),
    spec({ table: "gap_cases", rows: (d) => d.gapCases, toRow: (g) => w.fromGapCase(g) }),
    spec({ table: "interventions", rows: (d) => d.interventions, toRow: (i) => w.fromIntervention(i) }),
    spec({ table: "courses", rows: (d) => d.courses, toRow: (c) => w.fromCourse(c) }),
    spec({ table: "course_modules", rows: (d) => d.courseModules, toRow: (m) => w.fromCourseModule(m) }),
    spec({ table: "enrollments", rows: (d) => d.enrollments, toRow: (e) => w.fromEnrollment(e) }),
    spec({
      table: "module_completions",
      rows: (d) => d.moduleCompletions,
      toRow: (c, database) => w.fromModuleCompletion(c, courseIdFor(database, c.enrollmentId)),
    }),
    spec({
      table: "signals",
      rows: (d) => d.signals,
      toRow: (s) => w.fromSignal(s),
      junctions: [
        { table: "signal_job_roles", parentColumn: "signal_id", toRows: (s) => w.fromSignalJobRoles(s) },
        { table: "signal_skills", parentColumn: "signal_id", toRows: (s) => w.fromSignalSkills(s) },
      ],
    }),
    spec({ table: "notifications", rows: (d) => d.notifications, toRow: (n) => w.fromNotification(n) }),
  ];
}

export async function persistSnapshotChanges(
  db: Queryable,
  repo: OsaRepository,
  before: Database,
  after: Database,
  actorId: string,
): Promise<void> {
  for (const table of specs(actorId)) {
    const previous = byId(table.rows(before));
    const current = byId(table.rows(after));

    for (const [id, item] of current) {
      const original = previous.get(id);
      const unchanged = original !== undefined && JSON.stringify(original) === JSON.stringify(item);
      if (unchanged) continue;

      const row = table.toRow(item, after, actorId);
      if (!row) continue;
      if (original === undefined) await insert(db, table.table, row);
      else await update(db, table.table, row);

      for (const junction of table.junctions ?? []) {
        // Replace wholesale: these carry no identity of their own, so a diff
        // would be more code than a delete-and-reinsert and no more correct.
        await db.query(`DELETE FROM osa.${junction.table} WHERE ${junction.parentColumn} = $1`, [toStorageId(id)]);
        for (const child of junction.toRows(item)) await insert(db, junction.table, child, "");
      }
    }

    for (const id of previous.keys()) {
      if (current.has(id)) continue;
      for (const junction of table.junctions ?? []) {
        await db.query(`DELETE FROM osa.${junction.table} WHERE ${junction.parentColumn} = $1`, [toStorageId(id)]);
      }
      await db.query(`DELETE FROM osa.${table.table} WHERE id = $1`, [toStorageId(id)]);
    }
  }

  // Audit events are NOT written here. The row's uuid is part of its HMAC and
  // the chain head must be read under a lock, so an event signed against the
  // snapshot would fail its own verification on the first read. Re-append each
  // new event through the repository, which signs it correctly.
  const known = new Set(before.auditEvents.map((event) => event.id));
  for (const event of after.auditEvents) {
    if (known.has(event.id)) continue;
    await repo.appendAudit({
      actorUserId: event.actorUserId,
      action: event.action,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      outcome: event.outcome,
      requestId: event.requestId,
      metadata: event.metadata,
    });
  }
}
