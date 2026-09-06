import "server-only";

/**
 * Course discovery, and the author's view of who is actually working through
 * one.
 *
 * WHAT THIS IS NOT
 *
 * It is not a store. There is no order, no basket, no ledger, no payout and no
 * charge anywhere in this system, and migration 009 deliberately adds none.
 * `listPriceCents` is an asking price a catalogue may DISPLAY; a control that
 * offers to take money for it would be a lie about what happens when it is
 * clicked, so no such control exists and none may be added on the strength of
 * this field.
 *
 * It is also not cross-tenant. `visibility = 'listed'` means "offered for
 * discovery", and the obvious next step — a marketplace where one tenant's
 * listed course appears in another's catalogue — is a product decision nobody
 * has taken and an RLS boundary nothing here may cross. So 'listed' resolves to
 * exactly the same rows as 'tenant' today. It is kept as a distinct value, and
 * surfaced as `marketplaceListed`, so that widening it later is one edit to
 * `VISIBILITY_SQL` rather than an archaeology exercise across every read.
 *
 * DATASTORE
 *
 * PostgreSQL only, like the assessment engine and for the same reason: the
 * aggregates below are the point of the feature, and a JSON-fixture branch that
 * recomputed them in TypeScript would be a second implementation of "how
 * popular is this course" that drifts from the first. `readTx` throws a
 * descriptive fault when DATABASE_URL is absent.
 */

import type { Principal } from "./auth";
import { authorize } from "./auth";
import type { Course } from "./domain";
import { isUuid } from "./db/ids";
import * as map from "./db/mapping";
import { notFound, outOfRange } from "./errors";
import { bool, iso, isoOrNull, num, numOrNull, readTx, scopePaths } from "./assessment/runtime";
import { scopeForPrincipal } from "./tenant-runtime";

export type CatalogSort = "popular" | "newest" | "title";

export type DiscoverOptions = {
  search?: string | null;
  skillId?: string | null;
  sort?: string | null;
};

export type CatalogCourse = Course & {
  moduleCount: number;
  /** Sum of every module's duration, so a card can say what it costs in time. */
  durationMinutes: number;
  enrollmentCount: number;
  completionCount: number;
  /**
   * Null, not 0, when nobody has enrolled. A brand-new course rendering "0%
   * completion" reads as a course people fail, which is the opposite of true;
   * null lets the caller render "no data yet".
   */
  completionRate: number | null;
  /** Distinct learners currently working through it: enrolled or in progress. */
  activeLearners: number;
  /** The caller has a live enrollment. Drives "Continue" instead of "Enrol". */
  isEnrolled: boolean;
  /**
   * `visibility = 'listed'`. Today this is a label, not a wider audience — see
   * VISIBILITY_SQL. It is returned so a UI can say "listed" honestly without
   * inferring it from a visibility string it would then have to keep in sync.
   */
  marketplaceListed: boolean;
};

export type CourseTrackingLearner = {
  enrollmentId: string;
  subjectUserId: string;
  displayName: string;
  email: string;
  status: string;
  score: number | null;
  /** Required modules this learner has finished, out of `requiredModuleCount`. */
  requiredModulesCompleted: number;
  completedAt: string | null;
  /**
   * The enrollment carries an evidence id. False is an ordinary outcome, not a
   * defect: an attendance-only course mints none, and a completion below the
   * course's passing score deliberately mints none either.
   */
  evidenceEmitted: boolean;
};

export type CourseTracking = {
  course: Course;
  moduleCount: number;
  requiredModuleCount: number;
  enrollmentCount: number;
  completionCount: number;
  /** Completions that actually produced competence evidence. */
  evidenceCount: number;
  learners: CourseTrackingLearner[];
};

/**
 * The read side of `Course`, in the order `map.toCourse` expects to find it.
 *
 * This repeats `COURSE_COLUMNS` in db/postgres.ts. It is repeated rather than
 * imported because that constant is module-private there; the row is mapped
 * through `map.toCourse` so at least the row -> domain translation stays a
 * single definition. If a sixth course column is added, both lists need it.
 */
const COURSE_COLUMNS = `c.id, c.tenant_id, c.org_unit_id, c.code, c.title, c.description, c.skill_id,
  c.target_level, c.evidence_rule, c.passing_score::float8 AS passing_score, c.validity_months,
  c.version, c.status, c.created_at,
  c.visibility, c.summary, c.instructor_user_id, c.list_price_cents, c.currency`;

/**
 * Who may FIND a course. The ONE place this rule lives.
 *
 *   'organization'  ou.path @> $1  — owned at or above the viewer's own org.
 *                   This is not a new rule: it is the delivery-visibility test
 *                   `availableCourses` and `OsaRepository.listCourses` already
 *                   use, so a course does not become discoverable by being read
 *                   through a different endpoint.
 *   'tenant'        anyone in the tenant.
 *   'listed'        anyone in the tenant, and nothing more. RLS scopes every
 *                   row in this transaction to `current_tenant_id()`, so a
 *                   cross-tenant clause here would return nothing rather than
 *                   more — it would be theatre. When a marketplace is actually
 *                   decided on, it changes here and nowhere else.
 *
 * Discovery is deliberately WIDER than administration — a learner administers
 * nothing and must still find a course to enrol on. But it is not narrower
 * either, which the first version of this got wrong: with only the delivery
 * test, a tenant administrator at the root organization saw an EMPTY catalogue,
 * because every seeded course is owned one level down and `ou.path @> viewer`
 * asks whether the course sits at or ABOVE the reader. An administrator cannot
 * be shown nothing on the screen that lists their own courses.
 *
 * So the organization case is the union of the two rules the product already
 * has: delivered to me (at or above my org), or inside a subtree I administer
 * (at or below my delegated roots). A learner has their own org as their only
 * root, so the second clause adds nothing for them and the delivery rule is
 * unchanged.
 */
const VISIBILITY_SQL = `(
       (c.visibility = 'organization' AND (ou.path @> $1::ltree OR ou.path <@ ANY($2::ltree[])))
    OR (c.visibility = 'tenant')
    OR (c.visibility = 'listed')
  )`;

/**
 * Fixed ORDER BY clauses, chosen by key.
 *
 * A sort parameter is caller-supplied text arriving in a URL and must never
 * reach the query as text. Every clause carries `c.id` last so that two courses
 * with the same popularity, date or title do not swap places between two reads
 * of the same page.
 */
const ORDER_BY: Record<CatalogSort, string> = {
  // "Hot courses": most enrolled first. Popularity, not quality — this counts
  // sign-ups, and says nothing about whether anybody finished.
  popular: "e.enrollment_count DESC, c.title ASC, c.id",
  newest: "c.created_at DESC, c.title ASC, c.id",
  title: "c.title ASC, c.id",
};

/** `%` and `_` are LIKE wildcards; a learner searching for "A_B" means A_B. */
const escapeLike = (value: string): string => value.replace(/[\\%_]/g, (char) => `\\${char}`);

function resolveSort(value: string | null | undefined): CatalogSort {
  if (value === null || value === undefined || value === "") return "popular";
  if (!Object.hasOwn(ORDER_BY, value)) {
    throw outOfRange(`sort must be one of: ${Object.keys(ORDER_BY).join(", ")}`);
  }
  return value as CatalogSort;
}

/**
 * A course id, skill id or any other identifier bound to a `uuid` column.
 *
 * Without this, "?skillId=banana" reaches PostgreSQL, fails `22P02 invalid
 * input syntax for type uuid`, and `problem()` serves it as an opaque 500 — a
 * caller's typo reported as a server fault.
 */
function uuidParam(value: string, field: string): string {
  if (!isUuid(value)) throw outOfRange(`${field} must be an identifier this workspace issued`);
  return value;
}

/**
 * Published courses the caller may enrol on, with the counts a catalogue needs.
 *
 * The counts are SQL aggregates over `osa.enrollments` in one lateral per
 * course rather than a second round trip per row: a catalogue of forty courses
 * was otherwise forty-one queries, and the N+1 is what makes a listing page
 * feel broken long before it fails.
 *
 * DISCLOSURE, stated deliberately: the aggregates span the whole tenant, so a
 * learner sees how many people are on a course including people outside their
 * own organization. They are counts — no name, no identity, no org — and a
 * catalogue that cannot say how many others are enrolled is not a catalogue.
 * `isEnrolled` is the only per-person fact here and it is about the caller.
 */
export async function discoverCourses(
  principal: Principal,
  options: DiscoverOptions = {},
): Promise<CatalogCourse[]> {
  authorize(principal, "course:read", { tenantId: principal.tenantId });
  const sort = resolveSort(options.sort);
  const search = (options.search ?? "").trim();

  return readTx(principal, async (client) => {
    const { viewer, roots } = scopePaths(principal);
    const { userId } = scopeForPrincipal(principal);

    // $1 viewer path and $2 delegated roots (both VISIBILITY_SQL), $3 the caller
    // (isEnrolled). Filters that may or may not be present are appended, so
    // their placeholders are taken from the array length rather than hard-coded
    // and quietly reused.
    const params: unknown[] = [viewer, roots, userId];
    const conditions = [
      // A draft is not offered to anyone, and a superseded version is not the
      // course you would be enrolling on: `valid_to IS NULL` is the current one.
      "c.status = 'published'",
      "c.valid_to IS NULL",
      VISIBILITY_SQL,
    ];
    if (search) {
      params.push(`%${escapeLike(search)}%`);
      const term = `$${params.length}`;
      // Summary and description are both searched: an author who wrote the
      // useful words in the syllabus rather than the blurb should still be found.
      conditions.push(`(c.title ILIKE ${term} OR c.code ILIKE ${term} OR c.summary ILIKE ${term} OR c.description ILIKE ${term})`);
    }
    if (options.skillId) {
      params.push(uuidParam(options.skillId, "skillId"));
      conditions.push(`c.skill_id = $${params.length}::uuid`);
    }

    const { rows } = await client.query(
      `SELECT ${COURSE_COLUMNS},
              m.module_count, m.duration_minutes,
              e.enrollment_count, e.completion_count, e.active_learners, e.is_enrolled
         FROM osa.courses c
         JOIN osa.org_units ou ON ou.tenant_id = c.tenant_id AND ou.id = c.org_unit_id
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS module_count,
                  coalesce(sum(cm.duration_minutes), 0)::int AS duration_minutes
             FROM osa.course_modules cm
            WHERE cm.tenant_id = c.tenant_id AND cm.course_id = c.id
         ) m ON true
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS enrollment_count,
                  count(*) FILTER (WHERE en.status = 'completed')::int AS completion_count,
                  count(DISTINCT en.subject_user_id)
                    FILTER (WHERE en.status IN ('enrolled','in_progress'))::int AS active_learners,
                  -- A completed or withdrawn enrollment does NOT count as
                  -- enrolled: the schema lets a learner re-enrol after either
                  -- (requalification), so reporting "enrolled" would hide the
                  -- one control they actually need.
                  coalesce(bool_or(en.subject_user_id = $3::uuid
                                   AND en.status IN ('enrolled','in_progress')), false) AS is_enrolled
             FROM osa.enrollments en
            WHERE en.tenant_id = c.tenant_id AND en.course_id = c.id
         ) e ON true
        WHERE ${conditions.join("\n          AND ")}
        ORDER BY ${ORDER_BY[sort]}`,
      params,
    );

    return rows.map((row) => {
      const course = map.toCourse(row);
      const enrollmentCount = num(row.enrollment_count);
      const completionCount = num(row.completion_count);
      return {
        ...course,
        moduleCount: num(row.module_count),
        durationMinutes: num(row.duration_minutes),
        enrollmentCount,
        completionCount,
        completionRate: enrollmentCount === 0 ? null : completionCount / enrollmentCount,
        activeLearners: num(row.active_learners),
        isEnrolled: bool(row.is_enrolled),
        marketplaceListed: course.visibility === "listed",
      };
    });
  });
}

/**
 * Who is on this course and how far they have got, for the person who owns it.
 *
 * SCOPE. The course's organization must sit at or below one of the caller's
 * delegated roots (`ou.path <@ ANY(roots)`) — the authoring test, not the
 * delivery test `discoverCourses` uses. Being able to SEE a course in a
 * catalogue must not be enough to read the roster of everyone taking it.
 *
 * A course outside that scope is 404, never 403: a 403 would confirm the id
 * exists, which tells a caller something about another organization's
 * catalogue that they were refused permission to know.
 *
 * `valid_to` is deliberately NOT filtered. A superseded course version still
 * has learners who were enrolled on it, and their progress is exactly what an
 * author needs to see before retiring it.
 */
export async function courseTracking(principal: Principal, courseId: string): Promise<CourseTracking> {
  // The single definition of "may author a course" is the role -> action table
  // in auth.ts (`course:update`: tenant_admin, tna_analyst). A local role
  // predicate here would be a second copy of it, and the copy that drifts is
  // the one that lets somebody read a roster they were never granted.
  authorize(principal, "course:update", { tenantId: principal.tenantId });
  const id = uuidParam(courseId, "courseId");

  return readTx(principal, async (client) => {
    const { roots } = scopePaths(principal);
    const { rows: courseRows } = await client.query(
      `SELECT ${COURSE_COLUMNS},
              (SELECT count(*)::int FROM osa.course_modules cm
                WHERE cm.tenant_id = c.tenant_id AND cm.course_id = c.id) AS module_count,
              (SELECT count(*)::int FROM osa.course_modules cm
                WHERE cm.tenant_id = c.tenant_id AND cm.course_id = c.id AND cm.required) AS required_module_count
         FROM osa.courses c
         JOIN osa.org_units ou ON ou.tenant_id = c.tenant_id AND ou.id = c.org_unit_id
        WHERE c.id = $1::uuid
          AND ou.path <@ ANY($2::ltree[])`,
      [id, roots],
    );
    const head = courseRows[0];
    if (!head) throw notFound("Course is not available in your scope");

    const { rows } = await client.query(
      // Driven by enrollments with a LEFT JOIN onto completions: a learner who
      // has enrolled and done nothing has no module_completions rows at all,
      // and a completion-driven read would omit exactly the people an author
      // most needs to see.
      //
      // The FILTER counts REQUIRED modules only, so "3 of 4" is measured
      // against the same set the completion rule in learning.ts uses. Counting
      // optional modules too would show a learner at 5 of 4, or at 4 of 6 when
      // they have in fact finished everything that matters.
      `SELECT en.id, en.subject_user_id, en.status,
              en.score::float8 AS score, en.completed_at,
              (en.evidence_id IS NOT NULL) AS evidence_emitted,
              u.display_name, u.email::text AS email,
              count(mc.id) FILTER (WHERE cm.required)::int AS required_modules_completed
         FROM osa.enrollments en
         JOIN osa.users u ON u.tenant_id = en.tenant_id AND u.id = en.subject_user_id
         LEFT JOIN osa.module_completions mc
           ON mc.tenant_id = en.tenant_id AND mc.enrollment_id = en.id
         LEFT JOIN osa.course_modules cm
           ON cm.tenant_id = mc.tenant_id AND cm.id = mc.module_id
        WHERE en.course_id = $1::uuid
        GROUP BY en.id, en.subject_user_id, en.status, en.score, en.completed_at,
                 en.evidence_id, u.display_name, u.email
        ORDER BY u.display_name, en.id`,
      [id],
    );

    const learners: CourseTrackingLearner[] = rows.map((row) => ({
      enrollmentId: String(row.id),
      subjectUserId: String(row.subject_user_id),
      displayName: String(row.display_name),
      email: String(row.email),
      status: String(row.status),
      score: numOrNull(row.score),
      requiredModulesCompleted: num(row.required_modules_completed),
      completedAt: isoOrNull(row.completed_at),
      evidenceEmitted: bool(row.evidence_emitted),
    }));

    return {
      course: map.toCourse(head),
      moduleCount: num(head.module_count),
      requiredModuleCount: num(head.required_module_count),
      enrollmentCount: learners.length,
      completionCount: learners.filter((learner) => learner.status === "completed").length,
      evidenceCount: learners.filter((learner) => learner.evidenceEmitted).length,
      learners,
    };
  });
}

/** The instant this view was assembled, for a caller rendering "as of". */
export const asOf = (): string => iso(new Date());
