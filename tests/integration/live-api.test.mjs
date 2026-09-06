/**
 * The live API contract, exercised against a running production bundle.
 *
 * WHAT CHANGED AND WHY IT MATTERS
 *
 * This suite used to hard-code the JSON store's fixture identifiers —
 * `ten_northstar`, `org_ns_ops`, `usr_learner`, `gap_loto`. Under PostgreSQL
 * every one of those becomes a derived uuid, so the suite could only ever pass
 * against the datastore that is NOT the system of record. It was green on a
 * path production does not take.
 *
 * Every identifier is now discovered from the API itself. The suite therefore
 * asserts the CONTRACT rather than the fixture, and runs unchanged against
 * either datastore — which is the only way "integration tests pass" can mean
 * anything about a deployment.
 *
 * RUNNING IT
 *
 *   ./scripts/run-live-integration.sh            # provisions + runs both modes
 *   E2E_BASE_URL=http://127.0.0.1:3000 node --test tests/integration/live-api.test.mjs
 *
 * Assessment coverage is skipped, with a reported reason, when the target is not
 * backed by PostgreSQL: the assessment engine has no JSON-store implementation,
 * and a silently-passing empty suite would be worse than an honest skip.
 */

import assert from 'node:assert/strict';
import { before, describe, test } from 'node:test';

const baseUrl = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
const PASSWORD = 'Demo!2026';
const TENANT = process.env.E2E_TENANT_SLUG ?? 'northstar';
const OTHER_TENANT = process.env.E2E_CROSS_TENANT_SLUG ?? 'gulf-energy';

async function login(email, tenantSlug) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, ...(tenantSlug ? { tenantSlug } : {}) })
  });
  if (response.status !== 200) throw new Error(`Login failed (${response.status}): ${await response.text()}`);
  const body = await response.json();
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
  assert.ok(cookie?.startsWith('ik_session='));
  assert.ok(body.csrfToken);
  return { cookie, csrfToken: body.csrfToken, user: body.user };
}

async function call(path, { session, method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrfToken } : {}),
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

/** Discovered once and shared, so no test depends on a fixture literal. */
const world = { postgres: false, analyst: null, manager: null, learner: null, admin: null, gulfAdmin: null, bootstrap: null };

before(async () => {
  const health = await call('/api/health');
  assert.equal(health.response.status, 200);
  // The health endpoint names the datastore that actually answered. Deciding
  // this from `persistence: "available"` would have been wrong: that field is a
  // literal and is reported by both modes.
  world.postgres = health.body.datastore === 'postgresql';

  world.analyst = await login('analyst@northstar.example', TENANT);
  world.manager = await login('manager@northstar.example', TENANT);
  world.learner = await login('technician@northstar.example', TENANT);
  world.admin = await login('admin@northstar.example', TENANT);
  world.gulfAdmin = await login('admin@gulf.example', OTHER_TENANT);
  world.bootstrap = (await call('/api/platform/bootstrap', { session: world.admin })).body;
});

/** The org unit the analyst owns, discovered from their own session. */
const analystOrg = () => world.analyst.user.orgUnitId;

test('health discloses nothing secret', async () => {
  const health = await call('/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(JSON.stringify(health.body).includes('password'), false);
  assert.equal(JSON.stringify(health.body).toLowerCase().includes('postgres://'), false);
  assert.equal(JSON.stringify(health.body).toLowerCase().includes('secret'), false);
});

test('a wrong password is refused without disclosing whether the account exists', async () => {
  // Both of these must be indistinguishable to an attacker enumerating accounts.
  const unknown = await call('/api/auth/login', {
    method: 'POST', body: { tenantSlug: TENANT, email: 'nobody@northstar.example', password: 'wrong-password' }
  });
  const known = await call('/api/auth/login', {
    method: 'POST', body: { tenantSlug: TENANT, email: 'admin@northstar.example', password: 'wrong-password' }
  });
  assert.equal(unknown.response.status, 401);
  assert.equal(known.response.status, 401);
  assert.equal(unknown.body.error, known.body.error);
});

test('a workspace is part of the credential, not a hint', async () => {
  // The right password in the wrong workspace is not a sign-in. This is the
  // tenant-first contract: the same address in two workspaces is two accounts.
  const wrongWorkspace = await call('/api/auth/login', {
    method: 'POST', body: { tenantSlug: OTHER_TENANT, email: 'admin@northstar.example', password: PASSWORD }
  });
  assert.equal(wrongWorkspace.response.status, 401);
});

test('tenant scope is session-derived and datasets are disjoint', async () => {
  // A tenant id supplied by the caller must be ignored entirely.
  const northstar = await call(`/api/platform/bootstrap?tenantId=${encodeURIComponent(world.gulfAdmin.user.tenantId)}`, { session: world.admin });
  assert.equal(northstar.response.status, 200);
  assert.equal(northstar.body.tenant.slug, TENANT);
  assert.equal(JSON.stringify(northstar.body).includes('Gulf Energy Services'), false);

  const gulf = await call('/api/platform/bootstrap', { session: world.gulfAdmin });
  assert.equal(gulf.response.status, 200);
  assert.equal(gulf.body.tenant.slug, OTHER_TENANT);
  assert.equal(JSON.stringify(gulf.body).includes('Northstar Utilities'), false);
  assert.notEqual(northstar.body.tenant.id, gulf.body.tenant.id);
});

test('the tenant administration surfaces answer for a real tenant', async (t) => {
  // People and organization management is PostgreSQL-only, like the assessment
  // engine: tenant-admin-store.ts has no JSON-store path at all.
  if (!world.postgres) return t.skip('Tenant administration is PostgreSQL-only; no database is configured for this run.');
  // Both of these returned 500 for every tenant administrator on PostgreSQL
  // until the delegated scope was converted to ltree before binding.
  const orgs = await call('/api/admin/org-units', { session: world.admin });
  assert.equal(orgs.response.status, 200, JSON.stringify(orgs.body));
  assert.ok(orgs.body.items.length >= 1, 'a tenant administrator sees at least their root organization');

  const users = await call('/api/admin/users', { session: world.admin });
  assert.equal(users.response.status, 200, JSON.stringify(users.body));
  assert.ok(users.body.items.length >= 1);
  assert.equal(JSON.stringify(users.body).includes('passwordHash'), false, 'no password material crosses the API');
});

test('TNA, evidence, intervention and audit lifecycle is persisted and scoped', async () => {
  const title = `Integration readiness ${Date.now()}`;
  const targetRoleId = world.bootstrap.jobRoles[0]?.id;
  assert.ok(targetRoleId, 'the seeded tenant has at least one job role');

  const tna = await call('/api/tna', {
    session: world.analyst, method: 'POST',
    body: { orgUnitId: analystOrg(), title, objective: 'Verify the operational readiness loop.', targetRoleIds: [targetRoleId], dueDate: '2026-09-30' }
  });
  assert.equal(tna.response.status, 201, JSON.stringify(tna.body));
  assert.equal(tna.body.tenantId, world.analyst.user.tenantId);

  const tnaList = await call('/api/tna', { session: world.analyst });
  assert.ok(tnaList.body.items.some((item) => item.id === tna.body.id));

  const skillId = world.bootstrap.skills[0]?.id;
  assert.ok(skillId, 'the seeded tenant has at least one skill');
  const evidence = await call('/api/evidence', {
    session: world.manager, method: 'POST',
    body: {
      orgUnitId: world.manager.user.orgUnitId, subjectUserId: world.learner.user.id, skillId,
      type: 'observation', proficiencyLevel: 3, strength: 0.9, sourceReference: `INT-OBS-${Date.now()}`
    }
  });
  assert.equal(evidence.response.status, 201, JSON.stringify(evidence.body));
  assert.equal(evidence.body.status, 'verified', 'an assessor-held role verifies on write');

  const gaps = await call('/api/gaps', { session: world.analyst });
  assert.equal(gaps.response.status, 200);
  const gapCaseId = gaps.body.items[0]?.id;
  assert.ok(gapCaseId, 'the seeded tenant has at least one gap case');
  const intervention = await call('/api/interventions', {
    session: world.analyst, method: 'POST',
    body: { gapCaseId, type: 'process', title: 'Protect a pre-shift inspection window', dueDate: '2026-09-12' }
  });
  assert.equal(intervention.response.status, 201, JSON.stringify(intervention.body));

  const audit = await call('/api/audit', { session: world.admin });
  assert.equal(audit.response.status, 200);
  assert.equal(audit.body.integrity.valid, true, 'the ledger verifies under the secret that signed it');
  assert.ok(audit.body.items.some((item) => item.action === 'tna.create' && item.resourceId === tna.body.id));
  assert.ok(audit.body.items.some((item) => item.action === 'evidence.create' && item.resourceId === evidence.body.id));
  assert.ok(audit.body.items.some((item) => item.action === 'intervention.create' && item.resourceId === intervention.body.id));
});

test('a learner cannot author evidence about anyone', async () => {
  const denied = await call('/api/evidence', {
    session: world.learner, method: 'POST',
    body: {
      orgUnitId: world.manager.user.orgUnitId, subjectUserId: world.manager.user.id,
      skillId: world.bootstrap.skills[0].id, proficiencyLevel: 5, strength: 1, sourceReference: 'unauthorized'
    }
  });
  assert.equal(denied.response.status, 403);
});

test('a state change without a CSRF token is refused', async () => {
  const response = await fetch(`${baseUrl}/api/tna`, {
    method: 'POST',
    headers: { cookie: world.analyst.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ orgUnitId: analystOrg(), title: 'No CSRF', objective: 'Should not persist.', targetRoleIds: [], dueDate: '2026-09-30' })
  });
  assert.equal(response.status, 403);
});

test('logout destroys the server-side session', async () => {
  const session = await login('analyst@northstar.example', TENANT);
  assert.equal((await call('/api/auth/session', { session })).response.status, 200);
  assert.equal((await call('/api/auth/logout', { session, method: 'POST' })).response.status, 200);
  assert.equal((await call('/api/auth/session', { session })).response.status, 401);
});

/* -------------------------------------------------------------------------
 * Assessment engine.
 *
 * PostgreSQL-only by construction: there is no JSON-store implementation, and
 * there should not be one. Skipped with a reason rather than passed vacuously.
 * ---------------------------------------------------------------------- */

describe('assessment engine', () => {
  const skipReason = 'The assessment engine is PostgreSQL-only; no database is configured for this run.';

  test('author → learner → assessor produces a marked, audited result', async (t) => {
    if (!world.postgres) return t.skip(skipReason);

    const suffix = Date.now().toString(36).toUpperCase();
    const author = world.analyst;

    const bank = await call('/api/assessment-banks', {
      session: author, method: 'POST',
      body: { orgUnitId: analystOrg(), code: `INT-${suffix}`, name: `Integration bank ${suffix}`, description: 'Disposable' }
    });
    assert.equal(bank.response.status, 201, JSON.stringify(bank.body));

    const objective = await call('/api/assessment-questions', {
      session: author, method: 'POST',
      body: {
        bankId: bank.body.id, questionType: 'single_choice',
        prompt: 'Which access model assigns permissions through job roles?',
        options: { choices: [{ id: 'o1', label: 'RBAC' }, { id: 'o2', label: 'Shared passwords' }] },
        answerKey: { value: 'o1' }, rationale: 'RBAC is role-based access control.',
        points: 2, difficulty: 2, bloomLevel: 'understand', origin: 'manual', reviewStatus: 'approved'
      }
    });
    assert.equal(objective.response.status, 201, JSON.stringify(objective.body));

    const essay = await call('/api/assessment-questions', {
      session: author, method: 'POST',
      body: {
        bankId: bank.body.id, questionType: 'long_text',
        prompt: 'Explain how least privilege reduces operational risk.',
        options: {}, answerKey: {}, rationale: 'Reduced permissions, unauthorized action, blast radius.',
        points: 8, difficulty: 3, bloomLevel: 'analyze', origin: 'manual', reviewStatus: 'approved'
      }
    });
    assert.equal(essay.response.status, 201, JSON.stringify(essay.body));

    const assessment = await call('/api/assessments', {
      session: author, method: 'POST',
      body: {
        orgUnitId: analystOrg(), code: `EXAM-${suffix}`, title: `Integration mixed exam ${suffix}`,
        description: 'One objective question and one essay', assessmentType: 'exam',
        durationMinutes: 30, passPercentage: 70, attemptLimit: 1, feedbackMode: 'after_submit'
      }
    });
    assert.equal(assessment.response.status, 201, JSON.stringify(assessment.body));
    assert.equal(assessment.body.status, 'draft', 'a new assessment is never born published');

    // Publishing before any question is attached must be refused, and the
    // refusal must be readable — not a 500.
    const prematurePublish = await call('/api/assessments', {
      session: author, method: 'PATCH', body: { action: 'publish', assessmentId: assessment.body.id }
    });
    assert.equal(prematurePublish.response.status, 409, JSON.stringify(prematurePublish.body));
    assert.match(prematurePublish.body.error, /at least one question/i);

    for (const question of [objective, essay]) {
      const attached = await call('/api/assessments', {
        session: author, method: 'PATCH',
        body: { action: 'attach_question', assessmentId: assessment.body.id, questionId: question.body.id }
      });
      assert.equal(attached.response.status, 200, JSON.stringify(attached.body));
    }

    const published = await call('/api/assessments', {
      session: author, method: 'PATCH', body: { action: 'publish', assessmentId: assessment.body.id }
    });
    assert.equal(published.response.status, 200, JSON.stringify(published.body));

    /* --- learner ------------------------------------------------------- */
    const learner = world.learner;
    const attempt = await call('/api/assessment-attempts', {
      session: learner, method: 'POST', body: { assessmentId: assessment.body.id }
    });
    assert.equal(attempt.response.status, 201, JSON.stringify(attempt.body));

    // ANSWER-KEY SECRECY. The learner payload must not carry the key, the
    // rationale, or anything derived from them, at any depth.
    const learnerPayload = JSON.stringify(attempt.body);
    assert.equal(learnerPayload.includes('answerKey'), false, 'answer key reached the learner');
    assert.equal(learnerPayload.includes('answer_key'), false, 'answer key reached the learner');
    assert.equal(learnerPayload.includes('rationale'), false, 'rationale reached the learner');
    assert.equal(learnerPayload.includes('RBAC is role-based'), false, 'rationale text reached the learner');
    for (const question of attempt.body.questions) {
      assert.equal('answerKey' in question, false);
      assert.equal('rationale' in question, false);
    }

    // The server, not the browser, states the deadline.
    assert.ok(attempt.body.deadlineAt, 'a timed assessment reports a server-computed deadline');
    assert.ok(attempt.body.serverNow, 'the server reports its own clock');
    assert.ok(Date.parse(attempt.body.deadlineAt) > Date.parse(attempt.body.serverNow));

    const byType = Object.fromEntries(attempt.body.questions.map((q) => [q.questionType, q.id]));
    const saveObjective = await call('/api/assessment-attempts', {
      session: learner, method: 'PATCH',
      body: { action: 'save_response', attemptId: attempt.body.attempt.id, questionId: byType.single_choice, response: { value: 'o1' } }
    });
    assert.equal(saveObjective.response.status, 200, JSON.stringify(saveObjective.body));

    const saveEssay = await call('/api/assessment-attempts', {
      session: learner, method: 'PATCH',
      body: { action: 'save_response', attemptId: attempt.body.attempt.id, questionId: byType.long_text, response: { value: 'Least privilege limits blast radius by removing permissions nobody needs.' } }
    });
    assert.equal(saveEssay.response.status, 200, JSON.stringify(saveEssay.body));

    const submitted = await call('/api/assessment-attempts', {
      session: learner, method: 'PATCH', body: { action: 'submit', attemptId: attempt.body.attempt.id }
    });
    assert.equal(submitted.response.status, 200, JSON.stringify(submitted.body));
    assert.equal(submitted.body.attempt.status, 'submitted', 'an essay leaves the attempt pending human marking');
    assert.equal(submitted.body.attempt.percentage, null, 'no percentage is published before marking is complete');
    assert.equal(submitted.body.attempt.passed, null);
    assert.equal(submitted.body.attempt.scorePoints, 2, 'the objective question autoscored');
    assert.equal(submitted.body.attempt.maxPoints, 10);

    /* --- assessor ------------------------------------------------------ */
    const assessor = world.manager;
    const queue = await call('/api/assessment-marking', { session: assessor });
    assert.equal(queue.response.status, 200, JSON.stringify(queue.body));
    const item = queue.body.items.find((entry) => entry.attemptId === submitted.body.attempt.id);
    assert.ok(item, 'the submitted essay is waiting in the marking queue');
    assert.equal(item.questionType, 'long_text');
    assert.equal(item.maxPoints, 8);

    // A score above the item's maximum is refused, readably.
    const tooHigh = await call('/api/assessment-attempts', {
      session: assessor, method: 'PATCH',
      body: { action: 'grade_response', responseId: item.responseId, score: 99, feedback: 'over the maximum' }
    });
    assert.equal(tooHigh.response.status, 400, JSON.stringify(tooHigh.body));
    assert.match(tooHigh.body.error, /between 0 and 8/);

    const graded = await call('/api/assessment-attempts', {
      session: assessor, method: 'PATCH',
      body: { action: 'grade_response', responseId: item.responseId, score: 6, feedback: 'Clear on blast radius; say more about revocation.' }
    });
    assert.equal(graded.response.status, 200, JSON.stringify(graded.body));
    assert.equal(graded.body.attempt.status, 'graded');
    assert.equal(graded.body.attempt.scorePoints, 8, '2 objective + 6 manual');
    assert.equal(graded.body.attempt.maxPoints, 10);
    assert.equal(graded.body.attempt.percentage, 80);
    assert.equal(graded.body.attempt.passed, true);

    /* --- audit --------------------------------------------------------- */
    const audit = await call('/api/audit', { session: world.admin });
    assert.equal(audit.body.integrity.valid, true);
    assert.ok(audit.body.items.some((entry) => entry.action === 'assessment.attempt.submit' && entry.resourceId === submitted.body.attempt.id));
    assert.ok(audit.body.items.some((entry) => entry.action === 'assessment.response.grade'));

    /* --- tenant isolation ---------------------------------------------- */
    const otherTenant = world.gulfAdmin;
    const theirAssessments = await call('/api/assessments', { session: otherTenant });
    assert.equal(theirAssessments.response.status, 200);
    assert.equal(
      theirAssessments.body.items.some((entry) => entry.id === assessment.body.id), false,
      'another tenant can list assessments but never sees this one',
    );
    const theirQueue = await call('/api/assessment-marking', { session: otherTenant });
    assert.equal(theirQueue.body.items.some((entry) => entry.attemptId === submitted.body.attempt.id), false);

    /* --- separation of duties ------------------------------------------ */
    const learnerAuthoring = await call('/api/assessment-questions', { session: learner });
    assert.equal(learnerAuthoring.response.status, 403, 'a learner cannot read the question library');
    const learnerMarking = await call('/api/assessment-marking', { session: learner });
    assert.equal(learnerMarking.response.status, 403, 'a learner cannot read the marking queue');
    const learnerGrading = await call('/api/assessment-attempts', {
      session: learner, method: 'PATCH',
      body: { action: 'grade_response', responseId: item.responseId, score: 8, feedback: 'self-awarded' }
    });
    assert.equal(learnerGrading.response.status, 403, 'a learner cannot grade');
  });

  test('a second attempt beyond the limit is refused readably', async (t) => {
    if (!world.postgres) return t.skip(skipReason);

    const suffix = `L${Date.now().toString(36).toUpperCase()}`;
    const author = world.analyst;
    const bank = await call('/api/assessment-banks', {
      session: author, method: 'POST',
      body: { orgUnitId: analystOrg(), code: `LIM-${suffix}`, name: `Limit bank ${suffix}`, description: '' }
    });
    const question = await call('/api/assessment-questions', {
      session: author, method: 'POST',
      body: {
        bankId: bank.body.id, questionType: 'true_false', prompt: 'Least privilege reduces blast radius.',
        options: {}, answerKey: { value: true }, points: 1, origin: 'manual', reviewStatus: 'approved'
      }
    });
    const assessment = await call('/api/assessments', {
      session: author, method: 'POST',
      body: { orgUnitId: analystOrg(), code: `LIM-${suffix}`, title: `Attempt limit ${suffix}`, assessmentType: 'quiz', passPercentage: 50, attemptLimit: 1 }
    });
    await call('/api/assessments', { session: author, method: 'PATCH', body: { action: 'attach_question', assessmentId: assessment.body.id, questionId: question.body.id } });
    await call('/api/assessments', { session: author, method: 'PATCH', body: { action: 'publish', assessmentId: assessment.body.id } });

    const learner = world.learner;
    const first = await call('/api/assessment-attempts', { session: learner, method: 'POST', body: { assessmentId: assessment.body.id } });
    assert.equal(first.response.status, 201, JSON.stringify(first.body));

    // Concurrent starts must not create a duplicate attempt.
    const [a, b] = await Promise.all([
      call('/api/assessment-attempts', { session: learner, method: 'POST', body: { assessmentId: assessment.body.id } }),
      call('/api/assessment-attempts', { session: learner, method: 'POST', body: { assessmentId: assessment.body.id } }),
    ]);
    assert.equal(a.response.status, 201);
    assert.equal(b.response.status, 201);
    assert.equal(a.body.attempt.id, first.body.attempt.id, 'a concurrent start resumes the one live attempt');
    assert.equal(b.body.attempt.id, first.body.attempt.id);

    const questionId = first.body.questions[0].id;
    await call('/api/assessment-attempts', { session: learner, method: 'PATCH', body: { action: 'save_response', attemptId: first.body.attempt.id, questionId, response: { value: true } } });
    const submitted = await call('/api/assessment-attempts', { session: learner, method: 'PATCH', body: { action: 'submit', attemptId: first.body.attempt.id } });
    assert.equal(submitted.response.status, 200, JSON.stringify(submitted.body));
    assert.equal(submitted.body.attempt.status, 'graded', 'an all-objective assessment finalizes on submit');
    assert.equal(submitted.body.attempt.passed, true);

    // Submitting the same attempt again must not double-count or corrupt it.
    const resubmit = await call('/api/assessment-attempts', { session: learner, method: 'PATCH', body: { action: 'submit', attemptId: first.body.attempt.id } });
    assert.equal(resubmit.response.status, 404, JSON.stringify(resubmit.body));

    const second = await call('/api/assessment-attempts', { session: learner, method: 'POST', body: { assessmentId: assessment.body.id } });
    assert.equal(second.response.status, 409, JSON.stringify(second.body));
    assert.match(second.body.error, /attempt limit/i);
  });

  test('the exam builder can change every item setting a draft owns', async (t) => {
    if (!world.postgres) return t.skip(skipReason);

    const suffix = `B${Date.now().toString(36).toUpperCase()}`;
    const author = world.analyst;
    const bank = await call('/api/assessment-banks', {
      session: author, method: 'POST',
      body: { orgUnitId: analystOrg(), code: `BLD-${suffix}`, name: `Builder bank ${suffix}`, description: '' }
    });
    assert.equal(bank.response.status, 201, JSON.stringify(bank.body));

    // A key naming an option that does not exist produced a question no learner
    // could ever answer correctly, and nothing rejected it. It must be refused
    // at authoring time, with the field named.
    const unanswerable = await call('/api/assessment-questions', {
      session: author, method: 'POST',
      body: {
        bankId: bank.body.id, questionType: 'single_choice', prompt: 'Broken by construction',
        options: { choices: [{ id: 'o1', label: 'A' }, { id: 'o2', label: 'B' }] },
        answerKey: { value: 'o9' }, points: 1
      }
    });
    assert.equal(unanswerable.response.status, 400, JSON.stringify(unanswerable.body));
    assert.match(unanswerable.body.fields.answerKey, /not one of the options/i);

    const make = (body) => call('/api/assessment-questions', { session: author, method: 'POST', body: { bankId: bank.body.id, ...body } });
    const first = await make({ questionType: 'single_choice', prompt: 'Pick A', options: { choices: [{ id: 'o1', label: 'A' }, { id: 'o2', label: 'B' }] }, answerKey: { value: 'o1' }, points: 2, reviewStatus: 'approved' });
    const second = await make({ questionType: 'true_false', prompt: 'Least privilege helps?', options: {}, answerKey: { value: true }, points: 3, reviewStatus: 'approved' });
    // origin: "ai" is forced to draft by the store, whatever the caller asks
    // for. That rule is the reason the review gate has to exist.
    const generated = await make({ questionType: 'long_text', prompt: 'Explain least privilege', options: {}, answerKey: {}, points: 5, origin: 'ai', reviewStatus: 'approved' });
    assert.equal(generated.response.status, 201, JSON.stringify(generated.body));
    assert.equal(generated.body.reviewStatus, 'draft', 'an AI-generated question is never born approved');

    const exam = await call('/api/assessments', {
      session: author, method: 'POST',
      body: { orgUnitId: analystOrg(), code: `BLD-${suffix}`, title: `Builder exam ${suffix}`, assessmentType: 'exam', durationMinutes: 20, passPercentage: 60, attemptLimit: 2 }
    });
    assert.equal(exam.response.status, 201, JSON.stringify(exam.body));
    for (const question of [first, second, generated]) {
      const attached = await call('/api/assessments', { session: author, method: 'PATCH', body: { action: 'attach_question', assessmentId: exam.body.id, questionId: question.body.id } });
      assert.equal(attached.response.status, 200, JSON.stringify(attached.body));
    }

    const detail = await call(`/api/assessments/${exam.body.id}`, { session: author });
    assert.equal(detail.response.status, 200, JSON.stringify(detail.body));
    assert.equal(detail.body.items.length, 3);
    assert.equal(detail.body.totalPoints, 10);
    assert.deepEqual(detail.body.items.map((item) => item.position), [1, 2, 3]);
    assert.deepEqual(detail.body.publishBlockers.map((blocker) => blocker.code), ['unapproved_questions']);

    // The publish gate the review workflow exists to serve.
    const blocked = await call('/api/assessments', { session: author, method: 'PATCH', body: { action: 'publish', assessmentId: exam.body.id } });
    assert.equal(blocked.response.status, 409, JSON.stringify(blocked.body));

    const reviewed = await call('/api/assessment-questions', { session: author, method: 'PATCH', body: { action: 'review', questionId: generated.body.id, reviewStatus: 'approved' } });
    assert.equal(reviewed.response.status, 200, JSON.stringify(reviewed.body));

    const ids = detail.body.items.map((item) => item.questionId);
    // A partial order must be refused, not silently applied — dropping an item
    // from an exam because the client sent a short list is unrecoverable.
    const partial = await call('/api/assessments', { session: author, method: 'PATCH', body: { action: 'reorder_questions', assessmentId: exam.body.id, questionIds: [ids[0]] } });
    assert.equal(partial.response.status, 409, JSON.stringify(partial.body));

    const reordered = await call('/api/assessments', { session: author, method: 'PATCH', body: { action: 'reorder_questions', assessmentId: exam.body.id, questionIds: [ids[2], ids[0], ids[1]] } });
    assert.equal(reordered.response.status, 200, JSON.stringify(reordered.body));

    // points_override and required were read by six queries and written by
    // none, so every item was permanently required at the question's own points.
    const overridden = await call('/api/assessments', { session: author, method: 'PATCH', body: { action: 'set_item', assessmentId: exam.body.id, questionId: ids[0], pointsOverride: 9, required: false } });
    assert.equal(overridden.response.status, 200, JSON.stringify(overridden.body));

    const updated = await call('/api/assessments', { session: author, method: 'PATCH', body: { action: 'update', assessmentId: exam.body.id, title: `Builder exam ${suffix} v2`, shuffleQuestions: true, shuffleOptions: true } });
    assert.equal(updated.response.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.title, `Builder exam ${suffix} v2`);
    assert.equal(updated.body.shuffleQuestions, true);

    const afterEdits = await call(`/api/assessments/${exam.body.id}`, { session: author });
    assert.deepEqual(afterEdits.body.items.map((item) => item.questionId), [ids[2], ids[0], ids[1]]);
    assert.equal(afterEdits.body.totalPoints, 17, '2 -> 9 override, plus 3 and 5');
    assert.equal(afterEdits.body.requiredPoints, 8, 'the overridden item is now optional');
    assert.deepEqual(afterEdits.body.publishBlockers, []);

    const detached = await call('/api/assessments', { session: author, method: 'PATCH', body: { action: 'detach_question', assessmentId: exam.body.id, questionId: ids[1] } });
    assert.equal(detached.response.status, 200, JSON.stringify(detached.body));
    const afterDetach = await call(`/api/assessments/${exam.body.id}`, { session: author });
    assert.equal(afterDetach.body.items.length, 2);
    // Positions must close up: the player's navigation and the marking queue's
    // ordering both read `position` as "nth question".
    assert.deepEqual(afterDetach.body.items.map((item) => item.position), [1, 2]);

    const published = await call('/api/assessments', { session: author, method: 'PATCH', body: { action: 'publish', assessmentId: exam.body.id } });
    assert.equal(published.response.status, 200, JSON.stringify(published.body));

    // A published assessment is frozen until it is returned to draft.
    const frozen = await call('/api/assessments', { session: author, method: 'PATCH', body: { action: 'set_item', assessmentId: exam.body.id, questionId: ids[0], required: true } });
    assert.equal(frozen.response.status, 409, JSON.stringify(frozen.body));
    assert.match(frozen.body.error, /draft/i);

    // Publishing what is already published must say so. The publish query used
    // to filter on `status='draft'`, which made an already-published assessment
    // indistinguishable from one in another organization: both came back as
    // "Draft assessment not found in your scope", telling the legitimate owner
    // they could not see their own live exam.
    const republish = await call('/api/assessments', { session: author, method: 'PATCH', body: { action: 'publish', assessmentId: exam.body.id } });
    assert.equal(republish.response.status, 409, JSON.stringify(republish.body));
    assert.match(republish.body.error, /already published/i);

    const unpublished = await call('/api/assessments', { session: author, method: 'PATCH', body: { action: 'unpublish', assessmentId: exam.body.id } });
    assert.equal(unpublished.response.status, 200, JSON.stringify(unpublished.body));
    assert.equal(unpublished.body.status, 'draft');
  });

  test('a learner can read back their own result, and only under the feedback policy', async (t) => {
    if (!world.postgres) return t.skip(skipReason);

    const suffix = `R${Date.now().toString(36).toUpperCase()}`;
    const author = world.analyst;
    const learner = world.learner;

    const bank = await call('/api/assessment-banks', {
      session: author, method: 'POST',
      body: { orgUnitId: analystOrg(), code: `RES-${suffix}`, name: `Result bank ${suffix}`, description: '' }
    });
    const question = await call('/api/assessment-questions', {
      session: author, method: 'POST',
      body: {
        bankId: bank.body.id, questionType: 'single_choice', prompt: 'Which is least privilege?',
        options: { choices: [{ id: 'o1', label: 'Only what the task needs' }, { id: 'o2', label: 'Everything' }] },
        answerKey: { value: 'o1' }, rationale: 'Least privilege grants only what the task needs.',
        points: 4, reviewStatus: 'approved'
      }
    });

    // after_close, with a closing time in the future: the mark must be withheld
    // even once the attempt is fully graded.
    const closesAt = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const assessment = await call('/api/assessments', {
      session: author, method: 'POST',
      body: {
        orgUnitId: analystOrg(), code: `RES-${suffix}`, title: `Result policy ${suffix}`,
        assessmentType: 'quiz', passPercentage: 50, attemptLimit: 1,
        feedbackMode: 'after_close', closesAt
      }
    });
    assert.equal(assessment.response.status, 201, JSON.stringify(assessment.body));
    await call('/api/assessments', { session: author, method: 'PATCH', body: { action: 'attach_question', assessmentId: assessment.body.id, questionId: question.body.id } });
    await call('/api/assessments', { session: author, method: 'PATCH', body: { action: 'publish', assessmentId: assessment.body.id } });

    const attempt = await call('/api/assessment-attempts', { session: learner, method: 'POST', body: { assessmentId: assessment.body.id } });
    assert.equal(attempt.response.status, 201, JSON.stringify(attempt.body));
    await call('/api/assessment-attempts', { session: learner, method: 'PATCH', body: { action: 'save_response', attemptId: attempt.body.attempt.id, questionId: attempt.body.questions[0].id, response: { value: 'o1' } } });
    const submitted = await call('/api/assessment-attempts', { session: learner, method: 'PATCH', body: { action: 'submit', attemptId: attempt.body.attempt.id } });
    assert.equal(submitted.body.attempt.status, 'graded');
    assert.equal(submitted.body.attempt.passed, true);

    // The learner can read the attempt back at all — before this there was no
    // GET, so a result was unreachable the moment the player was navigated away
    // from.
    const list = await call('/api/assessment-attempts', { session: learner });
    assert.equal(list.response.status, 200, JSON.stringify(list.body));
    assert.ok(list.body.items.some((item) => item.attempt.id === attempt.body.attempt.id));

    const result = await call(`/api/assessment-attempts?attemptId=${attempt.body.attempt.id}`, { session: learner });
    assert.equal(result.response.status, 200, JSON.stringify(result.body));
    // The overall score is never gated: a learner is always entitled to know
    // whether they passed.
    assert.equal(result.body.attempt.passed, true);
    assert.equal(result.body.attempt.percentage, 100);
    // The per-question mark is, and the reason is stated rather than silent.
    assert.equal(result.body.feedbackReleased, false);
    assert.equal(result.body.feedbackReleaseReason, 'awaiting_close');
    assert.equal(result.body.responses[0].score, null, 'the per-item mark is withheld until the assessment closes');
    assert.equal(result.body.responses[0].markWithheld, true);
    // And in no mode, at no point, does a learner-facing payload carry the key.
    const payload = JSON.stringify(result.body);
    assert.equal(payload.includes('answerKey'), false);
    assert.equal(payload.includes('answer_key'), false);
    assert.equal(payload.includes('rationale'), false);
    assert.equal(payload.includes('Least privilege grants only'), false);

    // Another learner's attempt id must not resolve to their script.
    const stranger = await call(`/api/assessment-attempts?attemptId=${attempt.body.attempt.id}`, { session: world.manager });
    assert.equal(stranger.response.status, 403, 'the learner result view is learner-only');
  });

  test('an exam an author does not administer cannot be edited', async (t) => {
    if (!world.postgres) return t.skip(skipReason);
    // A syntactically valid uuid that belongs to nobody must 404, not 500 and
    // not leak whether it exists in another tenant.
    const missing = await call(`/api/assessments/00000000-0000-4000-8000-00000000dead`, { session: world.analyst });
    assert.equal(missing.response.status, 404, JSON.stringify(missing.body));

    const learnerView = await call(`/api/assessments/00000000-0000-4000-8000-00000000dead`, { session: world.learner });
    assert.equal(learnerView.response.status, 403, 'the authoring detail view is author-only');
  });

  test('a graded assessment pass completes the course and emits evidence through the one authority', async (t) => {
    if (!world.postgres) return t.skip(skipReason);

    const suffix = `E${Date.now().toString(36).toUpperCase()}`;
    const author = world.analyst;
    const admin = world.admin;
    const learner = world.learner;
    const skillId = world.bootstrap.skills[0].id;

    /* --- an assessment ------------------------------------------------- */
    const bank = await call('/api/assessment-banks', {
      session: author, method: 'POST',
      body: { orgUnitId: analystOrg(), code: `EV-${suffix}`, name: `Evidence bank ${suffix}`, description: '' }
    });
    const question = await call('/api/assessment-questions', {
      session: author, method: 'POST',
      body: {
        bankId: bank.body.id, questionType: 'single_choice', prompt: 'Isolate before working?',
        options: { choices: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] },
        answerKey: { value: 'yes' }, points: 10, reviewStatus: 'approved'
      }
    });
    const assessment = await call('/api/assessments', {
      session: author, method: 'POST',
      body: { orgUnitId: analystOrg(), code: `EV-${suffix}`, title: `Evidence exam ${suffix}`, assessmentType: 'quiz', passPercentage: 80, attemptLimit: 3 }
    });
    await call('/api/assessments', { session: author, method: 'PATCH', body: { action: 'attach_question', assessmentId: assessment.body.id, questionId: question.body.id } });
    await call('/api/assessments', { session: author, method: 'PATCH', body: { action: 'publish', assessmentId: assessment.body.id } });

    /* --- a course whose evidence rule is `assessed` --------------------- */
    const course = await call('/api/courses', {
      session: admin, method: 'POST',
      body: {
        orgUnitId: admin.user.orgUnitId, code: `EVC-${suffix}`, title: `Evidence course ${suffix}`,
        description: 'Assessed course wired to a real assessment', skillId,
        targetLevel: 4, evidenceRule: 'assessed', passingScore: 0.8, validityMonths: 12, status: 'draft'
      }
    });
    assert.equal(course.response.status, 201, JSON.stringify(course.body));

    // Publishing an assessed course with no assessment module must be refused:
    // recordModuleCompletion computes the final score from assessment-module
    // scores, so such a course could never award anything at all.
    const prematureCourse = await call('/api/course-modules', { session: admin, method: 'PATCH', body: { action: 'publish', courseId: course.body.id } });
    assert.equal(prematureCourse.response.status, 409, JSON.stringify(prematureCourse.body));
    assert.match(prematureCourse.body.error, /assessment module|at least one module/i);

    const module = await call('/api/course-modules', {
      session: admin, method: 'POST',
      body: { courseId: course.body.id, title: 'Final assessment', kind: 'assessment', durationMinutes: 15, required: true, assessmentId: assessment.body.id }
    });
    assert.equal(module.response.status, 201, JSON.stringify(module.body));
    assert.equal(module.body.assessmentId, assessment.body.id);

    // One assessment backs at most one module, or a single passing attempt
    // would satisfy two modules of the same course and count twice.
    const duplicate = await call('/api/course-modules', {
      session: admin, method: 'POST',
      body: { courseId: course.body.id, title: 'Same assessment again', kind: 'assessment', durationMinutes: 15, required: true, assessmentId: assessment.body.id }
    });
    assert.equal(duplicate.response.status, 409, JSON.stringify(duplicate.body));

    // A non-assessment module cannot carry an assessment link.
    const wrongKind = await call('/api/course-modules', {
      session: admin, method: 'POST',
      body: { courseId: course.body.id, title: 'A reading', kind: 'lesson', durationMinutes: 10, required: false, assessmentId: assessment.body.id }
    });
    assert.equal(wrongKind.response.status, 409, JSON.stringify(wrongKind.body));

    const publishedCourse = await call('/api/course-modules', { session: admin, method: 'PATCH', body: { action: 'publish', courseId: course.body.id } });
    assert.equal(publishedCourse.response.status, 200, JSON.stringify(publishedCourse.body));

    /* --- the learner enrolls and fails --------------------------------- */
    const enrollment = await call('/api/enrollments', {
      session: admin, method: 'POST',
      body: { courseId: course.body.id, subjectUserId: learner.user.id, source: 'assigned' }
    });
    assert.equal(enrollment.response.status, 201, JSON.stringify(enrollment.body));

    const failing = await call('/api/assessment-attempts', { session: learner, method: 'POST', body: { assessmentId: assessment.body.id } });
    await call('/api/assessment-attempts', { session: learner, method: 'PATCH', body: { action: 'save_response', attemptId: failing.body.attempt.id, questionId: failing.body.questions[0].id, response: { value: 'no' } } });
    const failed = await call('/api/assessment-attempts', { session: learner, method: 'PATCH', body: { action: 'submit', attemptId: failing.body.attempt.id } });
    assert.equal(failed.body.attempt.passed, false, 'the wrong answer fails');

    // A FAILED assessment must not emit competence evidence, and must leave the
    // enrollment open for a retake. That decision belongs to
    // recordModuleCompletion and is not re-implemented anywhere.
    const afterFailure = await call('/api/enrollments', { session: learner });
    const failedEnrollment = afterFailure.body.items.find((item) => item.id === enrollment.body.id);
    assert.ok(failedEnrollment, 'the learner can see their own enrollment');
    assert.notEqual(failedEnrollment.status, 'completed', 'a failed assessment does not complete the course');
    assert.equal(failedEnrollment.evidenceId ?? null, null, 'a failed assessment emits no evidence');

    /* --- the retake passes --------------------------------------------- */
    const retake = await call('/api/assessment-attempts', { session: learner, method: 'POST', body: { assessmentId: assessment.body.id } });
    assert.equal(retake.response.status, 201, JSON.stringify(retake.body));
    await call('/api/assessment-attempts', { session: learner, method: 'PATCH', body: { action: 'save_response', attemptId: retake.body.attempt.id, questionId: retake.body.questions[0].id, response: { value: 'yes' } } });
    const passed = await call('/api/assessment-attempts', { session: learner, method: 'PATCH', body: { action: 'submit', attemptId: retake.body.attempt.id } });
    assert.equal(passed.body.attempt.passed, true);
    assert.equal(passed.body.attempt.percentage, 100);

    const afterPass = await call('/api/enrollments', { session: learner });
    const completed = afterPass.body.items.find((item) => item.id === enrollment.body.id);
    assert.equal(completed.status, 'completed', 'the passing attempt completed the course');
    assert.ok(completed.evidenceId, 'the passing attempt emitted evidence');

    // The evidence is the ordinary kind, minted by the ordinary authority, with
    // the properties learning.ts gives it — not a second kind invented by the
    // assessment engine.
    const evidence = await call('/api/evidence', { session: admin });
    const minted = evidence.body.items.find((item) => item.id === completed.evidenceId);
    assert.ok(minted, 'the evidence is visible through the ordinary evidence surface');
    assert.equal(minted.type, 'assessment');
    assert.equal(minted.status, 'verified');
    assert.equal(minted.proficiencyLevel, 4, "the course's target level");
    assert.equal(minted.subjectUserId, learner.user.id);
    assert.equal(minted.assessorUserId, null, 'machine-attested, so no assessor is claimed');
    assert.match(minted.sourceReference, /^COURSE:/);

    // And the ledger records the bridge itself, so "why did this person become
    // competent" is answerable from the audit trail alone.
    const audit = await call('/api/audit', { session: admin });
    assert.equal(audit.body.integrity.valid, true);
    assert.ok(
      audit.body.items.some((item) => item.action === 'assessment.course.progress' && item.resourceId === enrollment.body.id),
      'the assessment-to-course bridge is audited',
    );
  });

  test('an attendance-only course never emits competence evidence, however well the assessment went', async (t) => {
    if (!world.postgres) return t.skip(skipReason);

    const suffix = `A${Date.now().toString(36).toUpperCase()}`;
    const author = world.analyst;
    const admin = world.admin;
    const learner = world.learner;

    const bank = await call('/api/assessment-banks', { session: author, method: 'POST', body: { orgUnitId: analystOrg(), code: `AT-${suffix}`, name: `Attendance bank ${suffix}`, description: '' } });
    const question = await call('/api/assessment-questions', {
      session: author, method: 'POST',
      body: { bankId: bank.body.id, questionType: 'true_false', prompt: 'Attended the briefing?', options: {}, answerKey: { value: true }, points: 1, reviewStatus: 'approved' }
    });
    const assessment = await call('/api/assessments', { session: author, method: 'POST', body: { orgUnitId: analystOrg(), code: `AT-${suffix}`, title: `Attendance check ${suffix}`, assessmentType: 'quiz', passPercentage: 50, attemptLimit: 1 } });
    await call('/api/assessments', { session: author, method: 'PATCH', body: { action: 'attach_question', assessmentId: assessment.body.id, questionId: question.body.id } });
    await call('/api/assessments', { session: author, method: 'PATCH', body: { action: 'publish', assessmentId: assessment.body.id } });

    const course = await call('/api/courses', {
      session: admin, method: 'POST',
      body: {
        orgUnitId: admin.user.orgUnitId, code: `ATC-${suffix}`, title: `Attendance course ${suffix}`,
        description: 'Recording attendance is not a claim of competence', skillId: world.bootstrap.skills[0].id,
        // `courses_check1` requires an attendance-only course to carry no pass
        // mark, which the API now refuses rather than failing at the write.
        targetLevel: 4, evidenceRule: 'attendance_only', passingScore: 0, validityMonths: null, status: 'draft'
      }
    });
    assert.equal(course.response.status, 201, JSON.stringify(course.body));
    // And the combination the schema forbids is refused readably, not with a
    // 500 from a constraint violation at write time.
    const contradictory = await call('/api/courses', {
      session: admin, method: 'POST',
      body: {
        orgUnitId: admin.user.orgUnitId, code: `ATX-${suffix}`, title: `Contradictory ${suffix}`,
        description: 'attendance-only with a pass mark', skillId: world.bootstrap.skills[0].id,
        targetLevel: 4, evidenceRule: 'attendance_only', passingScore: 0.5, validityMonths: null, status: 'draft'
      }
    });
    assert.equal(contradictory.response.status, 400, JSON.stringify(contradictory.body));
    assert.match(contradictory.body.fields.passingScore, /attendance-only/i);

    const module = await call('/api/course-modules', { session: admin, method: 'POST', body: { courseId: course.body.id, title: 'Briefing check', kind: 'assessment', durationMinutes: 5, required: true, assessmentId: assessment.body.id } });
    assert.equal(module.response.status, 201, JSON.stringify(module.body));
    const publishedCourse = await call('/api/course-modules', { session: admin, method: 'PATCH', body: { action: 'publish', courseId: course.body.id } });
    assert.equal(publishedCourse.response.status, 200, JSON.stringify(publishedCourse.body));

    const enrollment = await call('/api/enrollments', { session: admin, method: 'POST', body: { courseId: course.body.id, subjectUserId: learner.user.id, source: 'assigned' } });
    assert.equal(enrollment.response.status, 201, JSON.stringify(enrollment.body));
    const attempt = await call('/api/assessment-attempts', { session: learner, method: 'POST', body: { assessmentId: assessment.body.id } });
    await call('/api/assessment-attempts', { session: learner, method: 'PATCH', body: { action: 'save_response', attemptId: attempt.body.attempt.id, questionId: attempt.body.questions[0].id, response: { value: true } } });
    const submitted = await call('/api/assessment-attempts', { session: learner, method: 'PATCH', body: { action: 'submit', attemptId: attempt.body.attempt.id } });
    assert.equal(submitted.body.attempt.passed, true, 'the learner answered correctly');

    const enrollments = await call('/api/enrollments', { session: learner });
    const completed = enrollments.body.items.find((item) => item.id === enrollment.body.id);
    // The course completes — attendance was recorded — but recording that
    // someone attended is not a claim that they can do the work.
    assert.equal(completed.status, 'completed');
    assert.equal(completed.evidenceId ?? null, null, 'an attendance-only course emits no competence evidence');
    assert.equal(completed.score, null);
  });

  test('the catalogue ranks by real enrolment and never crosses a tenant', async (t) => {
    if (!world.postgres) return t.skip(skipReason);

    const mine = await call('/api/catalog?sort=popular', { session: world.admin });
    assert.equal(mine.response.status, 200, JSON.stringify(mine.body));
    // An administrator at the root organization saw an EMPTY catalogue when the
    // visibility rule was only the delivery test: every seeded course is owned
    // one level down, and `ou.path @> viewer` asks whether the course sits at or
    // ABOVE the reader. A person cannot be shown nothing on the screen that
    // lists their own courses.
    assert.ok(mine.body.items.length >= 1, 'a tenant administrator sees their own catalogue');
    // "Hot courses" is a real aggregate over enrolments, not a stored counter.
    const counts = mine.body.items.map((item) => item.enrollmentCount);
    assert.deepEqual(counts, [...counts].sort((a, b) => b - a), 'popular sort is descending by enrolment');
    for (const item of mine.body.items) {
      // null, not 0, when nobody has enrolled: "0% complete" on a brand-new
      // course reads as "people fail this", which is a claim the data does not
      // support.
      assert.ok(item.completionRate === null || typeof item.completionRate === 'number');
      if (item.enrollmentCount === 0) assert.equal(item.completionRate, null);
      assert.ok(item.enrollmentCount >= item.completionCount);
    }

    const theirs = await call('/api/catalog?sort=popular', { session: world.gulfAdmin });
    assert.equal(theirs.response.status, 200);
    const mineIds = new Set(mine.body.items.map((item) => item.id));
    assert.equal(theirs.body.items.some((item) => mineIds.has(item.id)), false, 'no course crosses the tenant boundary');

    // Course tracking is author-only and scope-checked.
    const tracked = await call(`/api/catalog?courseId=${mine.body.items[0].id}`, { session: world.admin });
    assert.equal(tracked.response.status, 200, JSON.stringify(tracked.body));
    const learnerTracking = await call(`/api/catalog?courseId=${mine.body.items[0].id}`, { session: world.learner });
    assert.ok([403, 404].includes(learnerTracking.response.status), 'a learner cannot read course tracking');
    const foreignTracking = await call(`/api/catalog?courseId=${mine.body.items[0].id}`, { session: world.gulfAdmin });
    assert.ok([403, 404].includes(foreignTracking.response.status), 'another tenant cannot read course tracking');
  });

  test('a scheduled session records attendance, bounded and tenant-scoped', async (t) => {
    if (!world.postgres) return t.skip(skipReason);

    const starts = new Date(Date.now() + 86_400_000).toISOString();
    const ends = new Date(Date.now() + 86_400_000 + 3_600_000).toISOString();
    const session = await call('/api/live-sessions', {
      session: world.admin, method: 'POST',
      body: { orgUnitId: world.admin.user.orgUnitId, title: `Briefing ${Date.now()}`, description: 'Field briefing', startsAt: starts, endsAt: ends, timeZone: 'America/New_York', capacity: 20 }
    });
    assert.equal(session.response.status, 201, JSON.stringify(session.body));
    assert.equal(session.body.provider, 'manual', 'no video provider is integrated, and nothing may claim one');

    // A session that ends before it starts is a data-entry error. The schema
    // refuses it; the API must say so rather than surface a constraint 500.
    const backwards = await call('/api/live-sessions', {
      session: world.admin, method: 'POST',
      body: { orgUnitId: world.admin.user.orgUnitId, title: 'Backwards', description: '', startsAt: ends, endsAt: starts, timeZone: 'UTC' }
    });
    assert.equal(backwards.response.status, 400, JSON.stringify(backwards.body));

    const registered = await call('/api/session-attendance', {
      session: world.admin, method: 'POST', body: { action: 'register', sessionId: session.body.id, userIds: [world.learner.user.id] }
    });
    assert.equal(registered.response.status, 200, JSON.stringify(registered.body));

    const recorded = await call('/api/session-attendance', {
      session: world.admin, method: 'PATCH',
      body: { action: 'record', sessionId: session.body.id, entries: [{ subjectUserId: world.learner.user.id, status: 'attended', minutesAttended: 600, note: 'Typo: ten hours on a one-hour session' }] }
    });
    assert.equal(recorded.response.status, 200, JSON.stringify(recorded.body));

    const roster = await call(`/api/live-sessions?sessionId=${session.body.id}`, { session: world.admin });
    assert.equal(roster.response.status, 200);
    const row = roster.body.roster.find((entry) => entry.subjectUserId === world.learner.user.id);
    assert.ok(row, 'the registered learner is on the roster');
    assert.equal(row.status, 'attended');
    // 600 minutes on a 60-minute session is a typo, not a fact.
    assert.ok(row.minutesAttended <= 61, `minutes were capped at the session length, got ${row.minutesAttended}`);
    assert.ok(row.recordedAt, 'an attendance observation names when it was made');

    // A learner sees the session they are delivered, and no roster.
    const learnerView = await call('/api/live-sessions', { session: world.learner });
    assert.equal(learnerView.response.status, 200);

    // Another tenant sees neither the session nor its roster.
    const foreign = await call('/api/live-sessions', { session: world.gulfAdmin });
    assert.equal(foreign.body.items.some((item) => item.id === session.body.id), false);
    const foreignRoster = await call(`/api/live-sessions?sessionId=${session.body.id}`, { session: world.gulfAdmin });
    assert.ok([403, 404].includes(foreignRoster.response.status), 'another tenant cannot open the roster');
  });

  test('a recorded attendance completes an attendance-only course and emits no competence evidence', async (t) => {
    if (!world.postgres) return t.skip(skipReason);

    const suffix = `AT${Date.now().toString(36).toUpperCase()}`;
    const admin = world.admin;
    const learner = world.learner;

    const course = await call('/api/courses', {
      session: admin, method: 'POST',
      body: {
        orgUnitId: admin.user.orgUnitId, code: `SESS-${suffix}`, title: `Storm briefing ${suffix}`,
        description: 'Attendance is the whole requirement', skillId: world.bootstrap.skills[0].id,
        targetLevel: 4, evidenceRule: 'attendance_only', passingScore: 0, validityMonths: null, status: 'draft'
      }
    });
    assert.equal(course.response.status, 201, JSON.stringify(course.body));

    const module = await call('/api/course-modules', {
      session: admin, method: 'POST',
      body: { courseId: course.body.id, title: 'Attend the briefing', kind: 'lesson', durationMinutes: 60, required: true }
    });
    assert.equal(module.response.status, 201, JSON.stringify(module.body));
    const published = await call('/api/course-modules', { session: admin, method: 'PATCH', body: { action: 'publish', courseId: course.body.id } });
    assert.equal(published.response.status, 200, JSON.stringify(published.body));

    const enrollment = await call('/api/enrollments', {
      session: admin, method: 'POST', body: { courseId: course.body.id, subjectUserId: learner.user.id, source: 'assigned' }
    });
    assert.equal(enrollment.response.status, 201, JSON.stringify(enrollment.body));

    const starts = new Date(Date.now() - 7_200_000).toISOString();
    const ends = new Date(Date.now() - 3_600_000).toISOString();
    const session = await call('/api/live-sessions', {
      session: admin, method: 'POST',
      body: {
        orgUnitId: admin.user.orgUnitId, title: `Storm briefing ${suffix}`, description: 'Pre-season briefing',
        startsAt: starts, endsAt: ends, timeZone: 'America/New_York',
        courseId: course.body.id, moduleId: module.body.id
      }
    });
    assert.equal(session.response.status, 201, JSON.stringify(session.body));

    await call('/api/session-attendance', { session: admin, method: 'POST', body: { action: 'register', sessionId: session.body.id, userIds: [learner.user.id] } });

    // An ABSENCE completes nothing. Partial attendance is not attendance, and
    // an excusal is a reason not to hold someone to a requirement rather than a
    // claim they met it.
    const absent = await call('/api/session-attendance', {
      session: admin, method: 'PATCH',
      body: { action: 'record', sessionId: session.body.id, entries: [{ subjectUserId: learner.user.id, status: 'absent', minutesAttended: 0 }] }
    });
    assert.equal(absent.response.status, 200, JSON.stringify(absent.body));
    assert.equal(absent.body.courseModuleCompletions, 0, 'an absence completes nothing');
    const afterAbsence = await call('/api/enrollments', { session: learner });
    assert.notEqual(afterAbsence.body.items.find((item) => item.id === enrollment.body.id).status, 'completed');

    // Attending it does complete the course.
    const attended = await call('/api/session-attendance', {
      session: admin, method: 'PATCH',
      body: { action: 'record', sessionId: session.body.id, entries: [{ subjectUserId: learner.user.id, status: 'attended', minutesAttended: 60, note: 'Present throughout' }] }
    });
    assert.equal(attended.response.status, 200, JSON.stringify(attended.body));
    assert.equal(attended.body.courseModuleCompletions, 1);
    assert.equal(attended.body.coursesCompleted, 1);

    const completed = (await call('/api/enrollments', { session: learner })).body.items.find((item) => item.id === enrollment.body.id);
    assert.equal(completed.status, 'completed', 'the register completed the course');
    // THE RULE THAT MUST NEVER BEND. Recording that somebody attended is not a
    // claim that they can do the work, so the course completes and no
    // competence evidence exists.
    assert.equal(completed.evidenceId ?? null, null, 'attendance emits no competence evidence');
    assert.equal(completed.score, null);

    // And the bridge is in the ledger, so "why did this course complete" is
    // answerable from the audit trail alone.
    const audit = await call('/api/audit', { session: admin });
    assert.equal(audit.body.integrity.valid, true);
    assert.ok(audit.body.items.some((item) => item.action === 'session.attendance.progress' && item.resourceId === session.body.id));
  });

  test('attendance on an assessed course completes the module but still withholds evidence', async (t) => {
    if (!world.postgres) return t.skip(skipReason);

    const suffix = `AS${Date.now().toString(36).toUpperCase()}`;
    const admin = world.admin;
    const learner = world.learner;

    // An assessed course whose only required module is attended, never assessed.
    // recordModuleCompletion computes its final score from assessment-kind
    // module completions, so a null-scored attendance contributes nothing and
    // the pass gate withholds evidence. Attendance must not be a back door to
    // competence.
    const course = await call('/api/courses', {
      session: admin, method: 'POST',
      body: {
        orgUnitId: admin.user.orgUnitId, code: `ASSESS-${suffix}`, title: `Assessed by attendance? ${suffix}`,
        description: 'Attendance must not stand in for assessment', skillId: world.bootstrap.skills[0].id,
        targetLevel: 4, evidenceRule: 'assessed', passingScore: 0.8, validityMonths: 12, status: 'draft'
      }
    });
    const module = await call('/api/course-modules', {
      session: admin, method: 'POST',
      body: { courseId: course.body.id, title: 'Workshop', kind: 'lesson', durationMinutes: 60, required: true }
    });
    // An assessed course with no assessment module cannot be published at all —
    // it could never award anything. Attach one so the course is publishable,
    // and leave it unattempted.
    const bank = await call('/api/assessment-banks', { session: world.analyst, method: 'POST', body: { orgUnitId: analystOrg(), code: `AS-${suffix}`, name: `Bank ${suffix}`, description: '' } });
    const question = await call('/api/assessment-questions', {
      session: world.analyst, method: 'POST',
      body: { bankId: bank.body.id, questionType: 'true_false', prompt: 'Verified isolation?', options: {}, answerKey: { value: true }, points: 1, reviewStatus: 'approved' }
    });
    const exam = await call('/api/assessments', { session: world.analyst, method: 'POST', body: { orgUnitId: analystOrg(), code: `AS-${suffix}`, title: `Check ${suffix}`, assessmentType: 'quiz', passPercentage: 80, attemptLimit: 1 } });
    await call('/api/assessments', { session: world.analyst, method: 'PATCH', body: { action: 'attach_question', assessmentId: exam.body.id, questionId: question.body.id } });
    await call('/api/assessments', { session: world.analyst, method: 'PATCH', body: { action: 'publish', assessmentId: exam.body.id } });
    const assessmentModule = await call('/api/course-modules', {
      session: admin, method: 'POST',
      body: { courseId: course.body.id, title: 'Final check', kind: 'assessment', durationMinutes: 10, required: true, assessmentId: exam.body.id }
    });
    assert.equal(assessmentModule.response.status, 201, JSON.stringify(assessmentModule.body));
    assert.equal((await call('/api/course-modules', { session: admin, method: 'PATCH', body: { action: 'publish', courseId: course.body.id } })).response.status, 200);

    const enrollment = await call('/api/enrollments', { session: admin, method: 'POST', body: { courseId: course.body.id, subjectUserId: learner.user.id, source: 'assigned' } });
    const session = await call('/api/live-sessions', {
      session: admin, method: 'POST',
      body: {
        orgUnitId: admin.user.orgUnitId, title: `Workshop ${suffix}`, description: '',
        startsAt: new Date(Date.now() - 7_200_000).toISOString(), endsAt: new Date(Date.now() - 3_600_000).toISOString(),
        timeZone: 'UTC', courseId: course.body.id, moduleId: module.body.id
      }
    });
    await call('/api/session-attendance', { session: admin, method: 'POST', body: { action: 'register', sessionId: session.body.id, userIds: [learner.user.id] } });
    const attended = await call('/api/session-attendance', {
      session: admin, method: 'PATCH',
      body: { action: 'record', sessionId: session.body.id, entries: [{ subjectUserId: learner.user.id, status: 'attended', minutesAttended: 60 }] }
    });
    assert.equal(attended.response.status, 200, JSON.stringify(attended.body));
    assert.equal(attended.body.courseModuleCompletions, 1, 'the attended module is completed');

    const enrollments = (await call('/api/enrollments', { session: learner })).body.items;
    const row = enrollments.find((item) => item.id === enrollment.body.id);
    assert.notEqual(row.status, 'completed', 'the unattempted assessment still stands between the learner and completion');
    assert.equal(row.evidenceId ?? null, null, 'attendance is not a back door to competence evidence');
  });

  test('a hosted session issues its own unguessable room', async (t) => {
    if (!world.postgres) return t.skip(skipReason);

    const starts = new Date(Date.now() + 86_400_000).toISOString();
    const ends = new Date(Date.now() + 86_400_000 + 3_600_000).toISOString();

    // A provider with no adapter must be refused, not accepted and quietly
    // downgraded — a scheduler who asked for Zoom and got a manual session would
    // tell a cohort to expect a meeting that does not exist.
    for (const provider of ['zoom', 'teams', 'webex', 'anything']) {
      const refused = await call('/api/live-sessions', {
        session: world.admin, method: 'POST',
        body: { orgUnitId: world.admin.user.orgUnitId, title: `Bad ${provider}`, description: '', startsAt: starts, endsAt: ends, timeZone: 'UTC', provider }
      });
      assert.equal(refused.response.status, 400, `${provider}: ${JSON.stringify(refused.body)}`);
      assert.match(refused.body.error, /manual, jitsi/);
    }

    const hosted = await call('/api/live-sessions', {
      session: world.admin, method: 'POST',
      body: { orgUnitId: world.admin.user.orgUnitId, title: `Hosted class ${Date.now()}`, description: 'Held on the platform', startsAt: starts, endsAt: ends, timeZone: 'Europe/London', provider: 'jitsi' }
    });
    assert.equal(hosted.response.status, 201, JSON.stringify(hosted.body));
    assert.equal(hosted.body.provider, 'jitsi');
    assert.ok(hosted.body.joinUrl.startsWith('https://'), 'a hosted session carries a real join URL');
    // The room must not be derivable from anything the learner already has. An
    // id that appears in URLs, payloads and audit exports would make the room a
    // door anyone who has seen it can open.
    assert.equal(hosted.body.joinUrl.includes(hosted.body.id), false, 'the room is not the session id');
    assert.match(hosted.body.joinUrl, /\/ik-[A-Za-z0-9_-]{32}#config\.prejoinPageEnabled=true$/);

    // Stable across reads: a room that moved between page loads would scatter a
    // class across two calls.
    const reread = await call(`/api/live-sessions?sessionId=${hosted.body.id}`, { session: world.admin });
    assert.equal(reread.response.status, 200, JSON.stringify(reread.body));
    assert.equal(reread.body.session.joinUrl, hosted.body.joinUrl);

    // Two sessions never share a room.
    const second = await call('/api/live-sessions', {
      session: world.admin, method: 'POST',
      body: { orgUnitId: world.admin.user.orgUnitId, title: `Hosted class two ${Date.now()}`, description: '', startsAt: starts, endsAt: ends, timeZone: 'UTC', provider: 'jitsi' }
    });
    assert.notEqual(second.body.joinUrl, hosted.body.joinUrl);

    // The platform issues the room for a hosted session; a caller-supplied link
    // would let somebody point a course's learners anywhere.
    const hijack = await call('/api/live-sessions', {
      session: world.admin, method: 'POST',
      body: { orgUnitId: world.admin.user.orgUnitId, title: 'Hijack', description: '', startsAt: starts, endsAt: ends, timeZone: 'UTC', provider: 'jitsi', joinUrl: 'https://evil.example/room' }
    });
    assert.equal(hijack.response.status, 409, JSON.stringify(hijack.body));

    // A manual session still carries no room and claims no call.
    const manual = await call('/api/live-sessions', {
      session: world.admin, method: 'POST',
      body: { orgUnitId: world.admin.user.orgUnitId, title: `Manual ${Date.now()}`, description: '', startsAt: starts, endsAt: ends, timeZone: 'UTC' }
    });
    assert.equal(manual.body.provider, 'manual');
    assert.equal(manual.body.joinUrl, '');

    // And a hosted session is still invisible to another tenant.
    const foreign = await call('/api/live-sessions', { session: world.gulfAdmin });
    assert.equal(foreign.body.items.some((item) => item.id === hosted.body.id), false);
  });

  test('an author cannot reach another tenant, and a learner cannot reach another learner', async (t) => {
    if (!world.postgres) return t.skip(skipReason);

    // A cross-tenant org id supplied in a request body must be refused, not
    // silently accepted with the caller's own tenant substituted.
    const gulfBootstrap = (await call('/api/platform/bootstrap', { session: world.gulfAdmin })).body;
    const foreignOrgId = gulfBootstrap.organizations[0]?.id ?? world.gulfAdmin.user.orgUnitId;
    const crossTenant = await call('/api/assessment-banks', {
      session: world.analyst, method: 'POST',
      body: { orgUnitId: foreignOrgId, code: `X-${Date.now().toString(36)}`, name: 'Cross-tenant bank', description: '' }
    });
    assert.equal(crossTenant.response.status, 403, JSON.stringify(crossTenant.body));

    // An attempt id that does not belong to the caller must not resolve.
    const strangerAttempt = await call('/api/assessment-attempts', {
      session: world.learner, method: 'PATCH',
      body: { action: 'save_response', attemptId: '00000000-0000-4000-8000-000000000000', questionId: '00000000-0000-4000-8000-000000000001', response: { value: 'x' } }
    });
    assert.ok([403, 404, 409].includes(strangerAttempt.response.status), `expected a refusal, got ${strangerAttempt.response.status}`);
  });
});
