import { appendAudit } from "@/lib/server/audit";
import { assertCsrf, authorize, principalFromRequest } from "@/lib/server/auth";
import { availableCourses, orgFor } from "@/lib/server/domain-service";
import type { Course, Database, Id } from "@/lib/server/domain";
import { conflict, notFound } from "@/lib/server/errors";
import { json, objectBody, optionalEnum, problem, requestId, requiredString, ValidationError } from "@/lib/server/http";
import { modulesForCourse } from "@/lib/server/learning";
import { id as newId } from "@/lib/server/security";
import { mutateDatabase, readDatabase } from "@/lib/server/store";

/* ---------------------------------------------------------------------------
 * Catalogue fields (migration 009).
 *
 * Each reader returns `undefined` when the key is absent, which is what lets
 * POST fall back to a default and PATCH leave the stored value alone. A reader
 * that returned the default for an absent key would make every PATCH a full
 * overwrite, silently clearing a summary or a price the author never mentioned.
 * ------------------------------------------------------------------------- */

const VISIBILITIES = ["organization", "tenant", "listed"] as const;

function readVisibility(body: Record<string, unknown>): Course["visibility"] | undefined {
  if (!Object.hasOwn(body, "visibility")) return undefined;
  return optionalEnum(body, "visibility", VISIBILITIES, "organization");
}

function readSummary(body: Record<string, unknown>): string | undefined {
  if (!Object.hasOwn(body, "summary")) return undefined;
  const value = body.summary;
  if (value === null) return "";
  if (typeof value !== "string") throw new ValidationError("Validation failed", { summary: "Must be text" });
  if (value.trim().length > 400) throw new ValidationError("Validation failed", { summary: "Must be 400 characters or fewer" });
  return value.trim();
}

/**
 * The instructor must exist in this tenant. `courses_instructor_fk` is a
 * composite (tenant_id, instructor_user_id) foreign key, so a stranger's id
 * fails at the constraint and reaches the author as an opaque 500 rather than
 * as "no such user".
 */
function readInstructorId(body: Record<string, unknown>, db: Database, tenantId: string): Id | null | undefined {
  if (!Object.hasOwn(body, "instructorUserId")) return undefined;
  const value = body.instructorUserId;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new ValidationError("Validation failed", { instructorUserId: "Must be a user identifier" });
  const user = db.users.find((candidate) => candidate.id === value && candidate.tenantId === tenantId);
  if (!user) throw new ValidationError("Validation failed", { instructorUserId: "No such user in this workspace" });
  return user.id;
}

function readPriceCents(body: Record<string, unknown>): number | null | undefined {
  if (!Object.hasOwn(body, "listPriceCents")) return undefined;
  const value = body.listPriceCents;
  if (value === null || value === "") return null;
  const cents = Number(value);
  // Minor units, and whole ones: `list_price_cents integer` cannot hold 9.99,
  // and a fractional cent is a rounding argument nobody wants to have.
  if (!Number.isInteger(cents) || cents < 0) {
    throw new ValidationError("Validation failed", { listPriceCents: "Must be a whole number of minor units (for example 49900 for 499.00), 0 or more" });
  }
  return cents;
}

function readCurrency(body: Record<string, unknown>): string | null | undefined {
  if (!Object.hasOwn(body, "currency")) return undefined;
  const value = body.currency;
  if (value === null || value === "") return null;
  if (typeof value !== "string") throw new ValidationError("Validation failed", { currency: "Must be a three-letter ISO-4217 code, such as GBP" });
  // Upper-cased rather than refused: the column CHECK is `^[A-Z]{3}$`, and
  // rejecting "gbp" as invalid would be a 400 about nothing but shift keys.
  const code = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new ValidationError("Validation failed", { currency: "Must be a three-letter ISO-4217 code, such as GBP" });
  }
  return code;
}

/**
 * The two halves of a displayed price travel together.
 *
 * `courses_price_needs_currency` refuses any other pairing at the schema level,
 * and a constraint violation surfaces as an opaque 500 — so an author who typed
 * a price and forgot the currency would be told the server had broken. This
 * says which field is missing, in words.
 *
 * Checked against the MERGED values, not the request body: a PATCH that clears
 * only the currency of a priced course produces exactly the forbidden pairing
 * while sending nothing invalid on its own.
 *
 * A price here is DISPLAY only. Nothing in this system can take money for it.
 */
function assertPricePaired(listPriceCents: number | null, currency: string | null): void {
  if (listPriceCents !== null && currency === null) {
    throw new ValidationError("Validation failed", {
      currency: "A price needs a currency. Set currency to a three-letter code such as GBP, or clear listPriceCents.",
    });
  }
  if (listPriceCents === null && currency !== null) {
    throw new ValidationError("Validation failed", {
      listPriceCents: "A currency needs a price. Set listPriceCents, or clear currency.",
    });
  }
}

export async function GET(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    const db = await readDatabase();
    authorize(principal, "course:read", { tenantId: principal.tenantId });
    const courses = availableCourses(db, principal, db.courses);
    const items = courses.map((course) => {
      const modules = modulesForCourse(db, course.id);
      return {
        ...course,
        moduleCount: modules.length,
        durationMinutes: modules.reduce((total, module) => total + module.durationMinutes, 0),
        modules,
      };
    });
    return json({ items, asOf: new Date().toISOString() });
  } catch (error) { return problem(error, rid); }
}

export async function POST(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const db = await readDatabase();

    const orgUnitId = requiredString(body, "orgUnitId", 100);
    const skillId = requiredString(body, "skillId", 100);
    const org = orgFor(db, principal.tenantId, orgUnitId);
    const skill = db.skills.find((item) => item.id === skillId && item.tenantId === principal.tenantId);
    if (!org || !skill) throw new ValidationError("Validation failed", { reference: "Organization or skill not found in tenant" });
    authorize(principal, "course:create", { tenantId: principal.tenantId, orgUnit: org });

    const targetLevel = Number(body.targetLevel);
    if (!Number.isInteger(targetLevel) || targetLevel < 0 || targetLevel > 5) {
      throw new ValidationError("Validation failed", { targetLevel: "Target level must be an integer 0-5" });
    }
    const evidenceRule = optionalEnum(body, "evidenceRule", ["assessed", "attendance_only"] as const, "assessed");
    const passingScore = body.passingScore === undefined ? 0.8 : Number(body.passingScore);
    if (!Number.isFinite(passingScore) || passingScore < 0 || passingScore > 1) {
      throw new ValidationError("Validation failed", { passingScore: "Passing score must be between 0 and 1" });
    }
    if (evidenceRule === "attendance_only" && passingScore !== 0) {
      // The schema enforces this (`courses_check1`), so without the check here
      // the request reached the write and came back as an opaque 500. The rule
      // is real: an attendance-only course records that somebody turned up, and
      // a pass mark on a thing nobody is marked on is a number with no meaning.
      throw new ValidationError("Validation failed", {
        passingScore: "An attendance-only course has no passing score. Set it to 0, or make this course assessed.",
      });
    }
    const validityMonths = body.validityMonths === null || body.validityMonths === undefined ? null : Number(body.validityMonths);
    if (validityMonths !== null && (!Number.isInteger(validityMonths) || validityMonths <= 0)) {
      throw new ValidationError("Validation failed", { validityMonths: "Validity must be a positive whole number of months" });
    }

    const listPriceCents = readPriceCents(body) ?? null;
    const currency = readCurrency(body) ?? null;
    assertPricePaired(listPriceCents, currency);

    const course: Course = {
      id: newId(),
      tenantId: principal.tenantId,
      orgUnitId,
      code: requiredString(body, "code", 40),
      title: requiredString(body, "title", 200),
      description: requiredString(body, "description", 1000),
      skillId,
      targetLevel,
      evidenceRule,
      passingScore,
      validityMonths,
      version: 1,
      status: optionalEnum(body, "status", ["draft", "published", "retired"] as const, "draft"),
      createdAt: new Date().toISOString(),
      // Migration 009. `organization` is the default because it is the rule the
      // rest of the product already applies; a course becomes discoverable more
      // widely only when an author says so.
      visibility: readVisibility(body) ?? "organization",
      summary: readSummary(body) ?? "",
      instructorUserId: readInstructorId(body, db, principal.tenantId) ?? null,
      listPriceCents,
      currency,
    };

    await mutateDatabase((state) => state.courses.push(course));
    await appendAudit({
      tenantId: principal.tenantId, actorUserId: principal.user.id, action: "course.create",
      resourceType: "course", resourceId: course.id, outcome: "success", requestId: rid,
      metadata: { code: course.code, skillId, targetLevel, evidenceRule, visibility: course.visibility },
    });
    return json(course, { status: 201 });
  } catch (error) { return problem(error, rid); }
}

/**
 * Catalogue metadata on a course that has not been published yet.
 *
 * DRAFT ONLY, and that is the whole point of the gate. A published course is
 * what learners were enrolled on and what evidence was minted against; its
 * `valid_to`/`version` columns exist precisely so a change to a live course is
 * a new version rather than an edit under everyone's feet. Letting this PATCH
 * rewrite a published row would silently change the offer people had already
 * accepted, so it refuses with 409 and says why.
 *
 * Only the five migration-009 fields are editable here. Code, title, skill and
 * passing score decide what evidence a completion may mint, and belong to the
 * versioned authoring path rather than to a catalogue-listing endpoint.
 *
 * `action: "update"` is required in the body so a later `action` on this route
 * cannot be reached by an old client that omits it.
 */
export async function PATCH(request: Request): Promise<Response> {
  const rid = requestId(request);
  try {
    const principal = await principalFromRequest(request);
    assertCsrf(request, principal);
    const body = await objectBody(request);
    const action = requiredString(body, "action", 40);
    if (action !== "update") throw new ValidationError("Validation failed", { action: "Must be: update" });

    const db = await readDatabase();
    const courseId = requiredString(body, "courseId", 100);
    const course = db.courses.find((item) => item.id === courseId && item.tenantId === principal.tenantId);
    // 404 rather than 403: confirming the id exists would disclose another
    // organization's catalogue to somebody refused sight of it.
    if (!course) throw notFound("Course not found in your workspace");
    const org = orgFor(db, principal.tenantId, course.orgUnitId);
    if (!org) throw notFound("Course not found in your workspace");
    authorize(principal, "course:update", { tenantId: principal.tenantId, orgUnit: org });
    if (course.status !== "draft") {
      throw conflict("This course is published. Catalogue details on a live course change by issuing a new version, not by editing it.");
    }

    // Merged before validation: the stored value stands for any field the
    // request did not mention, and the price pairing is a rule about the row
    // that results, not about the keys that happened to be sent.
    const visibility = readVisibility(body) ?? course.visibility;
    const summary = readSummary(body) ?? course.summary;
    const instructorRead = readInstructorId(body, db, principal.tenantId);
    const instructorUserId = instructorRead === undefined ? course.instructorUserId : instructorRead;
    const priceRead = readPriceCents(body);
    const listPriceCents = priceRead === undefined ? course.listPriceCents : priceRead;
    const currencyRead = readCurrency(body);
    const currency = currencyRead === undefined ? course.currency : currencyRead;
    assertPricePaired(listPriceCents, currency);

    await mutateDatabase((state) => {
      const target = state.courses.find((item) => item.id === courseId && item.tenantId === principal.tenantId);
      if (!target) return;
      target.visibility = visibility;
      target.summary = summary;
      target.instructorUserId = instructorUserId;
      target.listPriceCents = listPriceCents;
      target.currency = currency;
    });
    await appendAudit({
      tenantId: principal.tenantId, actorUserId: principal.user.id, action: "course.update",
      resourceType: "course", resourceId: courseId, outcome: "success", requestId: rid,
      // The price is recorded because changing what a course asks for is the
      // kind of change somebody will later need to date. It is still only a
      // displayed figure: no charge, order or ledger exists behind it.
      metadata: { visibility, listPriceCents, currency, instructorUserId },
    });

    const updated = (await readDatabase()).courses.find(
      (item) => item.id === courseId && item.tenantId === principal.tenantId,
    );
    return json(updated ?? { ...course, visibility, summary, instructorUserId, listPriceCents, currency });
  } catch (error) { return problem(error, rid); }
}
