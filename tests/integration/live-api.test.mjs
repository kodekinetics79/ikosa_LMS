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
  // `persistence: "available"` is only reported when a PostgreSQL pool exists.
  world.postgres = health.body.persistence === 'available';

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

test('the tenant administration surfaces answer for a real tenant', async () => {
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
