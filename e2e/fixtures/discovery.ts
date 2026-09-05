import { expect, Page } from '@playwright/test';

/**
 * Runtime identifier discovery.
 *
 * The suite used to hard-code the JSON fixture store's literals - `ten_northstar`,
 * `org_ns_ops`, `usr_learner`, `skill_loto`, `gap_loto`, `mod_loto_4`. PostgreSQL
 * is the system of record and derives a uuid v5 for every one of them, so a spec
 * naming a literal could only pass against the datastore that is NOT production.
 *
 * Everything here reads the identifier back from the API instead, keyed on a
 * property that is part of the contract (a tenant `slug`, a course `code`, a
 * skill `code`, a user `email`, a module `kind`). The specs therefore assert the
 * contract rather than the seed, and run unchanged against either datastore.
 */

export interface DiscoveredTenant {
  id: string;
  slug: string;
  name: string;
}

export interface DiscoveredOrgUnit {
  id: string;
  name: string;
  path: string;
}

export interface DiscoveredJobRole {
  id: string;
  code: string;
  title: string;
}

export interface DiscoveredSkill {
  id: string;
  code: string;
  name: string;
}

export interface Bootstrap {
  tenant: DiscoveredTenant;
  user: { id: string; tenantId: string; orgUnitId: string; email: string; roles: string[] };
  organizations: DiscoveredOrgUnit[];
  jobRoles: DiscoveredJobRole[];
  skills: DiscoveredSkill[];
}

export interface CourseModule {
  id: string;
  position: number;
  title: string;
  kind: string;
  required: boolean;
}

export interface DiscoveredCourse {
  id: string;
  code: string;
  title: string;
  skillId: string;
  evidenceRule: string;
  targetLevel: number;
  passingScore: number;
  modules: CourseModule[];
}

export interface DiscoveredGapCase {
  id: string;
  subjectUserId: string;
  requirement: { skillId: string };
}

/** A syntactically valid uuid v4 that belongs to no tenant, user or row. */
export const UUID_BELONGING_TO_NOBODY = '00000000-0000-4000-8000-000000000000';

async function json<T>(page: Page, path: string): Promise<T> {
  const response = await page.request.get(path);
  expect(response.status(), `GET ${path} -> ${await response.text()}`).toBe(200);
  return (await response.json()) as T;
}

export async function bootstrap(page: Page): Promise<Bootstrap> {
  return json<Bootstrap>(page, '/api/platform/bootstrap');
}

export async function sessionUser(page: Page): Promise<Bootstrap['user']> {
  const body = await json<{ user: Bootstrap['user'] }>(page, '/api/auth/session');
  return body.user;
}

/** The first job role visible to the caller. Used where a spec needs "a" role. */
export async function anyJobRoleId(page: Page): Promise<string> {
  const { jobRoles } = await bootstrap(page);
  expect(jobRoles.length, 'the seeded tenant exposes at least one job role').toBeGreaterThan(0);
  return jobRoles[0].id;
}

export async function skillIdByCode(page: Page, code: string): Promise<string> {
  const { skills } = await bootstrap(page);
  const skill = skills.find((item) => item.code === code);
  expect(skill, `expected a skill with code ${code} in the caller's tenant`).toBeTruthy();
  return skill!.id;
}

export async function anySkillId(page: Page): Promise<string> {
  const { skills } = await bootstrap(page);
  expect(skills.length, 'the seeded tenant exposes at least one skill').toBeGreaterThan(0);
  return skills[0].id;
}

export async function courseByCode(page: Page, code: string): Promise<DiscoveredCourse> {
  const body = await json<{ items: DiscoveredCourse[] }>(page, '/api/courses');
  const course = body.items.find((item) => item.code === code);
  expect(course, `expected course ${code} in the caller's catalogue`).toBeTruthy();
  return course!;
}

/**
 * The gap case a spec needs is identified by what it is ABOUT - this subject and
 * this skill - not by a seed id. A gap case created by a different seed revision
 * still satisfies the journey; a renamed literal never would.
 */
export async function gapCaseForSkill(page: Page, subjectUserId: string, skillId: string): Promise<DiscoveredGapCase> {
  const body = await json<{ items: DiscoveredGapCase[] }>(page, '/api/gaps');
  const match = body.items.find((item) => item.subjectUserId === subjectUserId && item.requirement?.skillId === skillId);
  expect(match, 'expected an open gap case for this subject and skill').toBeTruthy();
  return match!;
}

export async function anyGapCaseId(page: Page): Promise<string> {
  const body = await json<{ items: { id: string }[] }>(page, '/api/gaps');
  expect(body.items.length, 'the seeded tenant exposes at least one gap case').toBeGreaterThan(0);
  return body.items[0].id;
}

export async function anyTnaStudyId(page: Page): Promise<string> {
  const body = await json<{ items: { id: string }[] }>(page, '/api/tna');
  expect(body.items.length, 'the seeded tenant exposes at least one TNA study').toBeGreaterThan(0);
  return body.items[0].id;
}
