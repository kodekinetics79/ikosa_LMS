import assert from 'node:assert/strict';
import { test } from 'node:test';

const baseUrl = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';

async function login(email, tenantSlug) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'Demo!2026', ...(tenantSlug ? { tenantSlug } : {}) })
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

test('health discloses no secret and invalid login is generic', async () => {
  const health = await call('/api/health');
  assert.equal(health.response.status, 200);
  assert.equal(JSON.stringify(health.body).includes('password'), false);
  const invalid = await call('/api/auth/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'wrong' } });
  assert.equal(invalid.response.status, 401);
  assert.match(invalid.body.error, /invalid email or password/i);
});

test('tenant scope is session-derived and datasets are disjoint', async () => {
  const northstar = await login('analyst@northstar.example', 'northstar');
  const ns = await call('/api/platform/bootstrap?tenantId=ten_gulf', { session: northstar });
  assert.equal(ns.response.status, 200);
  assert.equal(ns.body.tenant.id, 'ten_northstar');
  assert.equal(JSON.stringify(ns.body).includes('Gulf Energy Services'), false);

  const gulf = await login('admin@gulf.example', 'gulf-energy');
  const ge = await call('/api/platform/bootstrap', { session: gulf });
  assert.equal(ge.response.status, 200);
  assert.equal(ge.body.tenant.id, 'ten_gulf');
  assert.equal(JSON.stringify(ge.body).includes('Northstar Utilities'), false);
});

test('TNA, evidence, intervention and audit lifecycle is persisted and scoped', async () => {
  const analyst = await login('analyst@northstar.example', 'northstar');
  const title = `Integration readiness ${Date.now()}`;
  const tna = await call('/api/tna', {
    session: analyst, method: 'POST',
    body: { orgUnitId: 'org_ns_ops', title, objective: 'Verify the operational readiness loop.', targetRoleIds: ['role_field_tech'], dueDate: '2026-09-30' }
  });
  assert.equal(tna.response.status, 201, JSON.stringify(tna.body));
  assert.equal(tna.body.tenantId, 'ten_northstar');
  const tnaList = await call('/api/tna', { session: analyst });
  assert.ok(tnaList.body.items.some((item) => item.id === tna.body.id));

  const manager = await login('manager@northstar.example', 'northstar');
  const evidence = await call('/api/evidence', {
    session: manager, method: 'POST',
    body: { orgUnitId: 'org_ns_south', subjectUserId: 'usr_learner', skillId: 'skill_loto', type: 'observation', proficiencyLevel: 3, strength: 0.9, sourceReference: `INT-OBS-${Date.now()}` }
  });
  assert.equal(evidence.response.status, 201, JSON.stringify(evidence.body));
  assert.equal(evidence.body.status, 'verified');

  const intervention = await call('/api/interventions', {
    session: analyst, method: 'POST',
    body: { gapCaseId: 'gap_loto', type: 'process', title: 'Protect a pre-shift inspection window', dueDate: '2026-09-12' }
  });
  assert.equal(intervention.response.status, 201, JSON.stringify(intervention.body));
  assert.equal(intervention.body.type, 'process');

  const learner = await login('technician@northstar.example', 'northstar');
  const denied = await call('/api/evidence', {
    session: learner, method: 'POST',
    body: { orgUnitId: 'org_ns_south', subjectUserId: 'usr_manager', skillId: 'skill_loto', proficiencyLevel: 5, strength: 1, sourceReference: 'unauthorized' }
  });
  assert.equal(denied.response.status, 403);

  const admin = await login('admin@northstar.example', 'northstar');
  const audit = await call('/api/audit', { session: admin });
  assert.equal(audit.response.status, 200);
  assert.equal(audit.body.integrity.valid, true);
  assert.ok(audit.body.items.some((item) => item.action === 'tna.create' && item.resourceId === tna.body.id));
  assert.ok(audit.body.items.some((item) => item.action === 'evidence.create' && item.resourceId === evidence.body.id));
  assert.ok(audit.body.items.some((item) => item.action === 'intervention.create' && item.resourceId === intervention.body.id));
});

test('logout destroys the server-side session', async () => {
  const analyst = await login('analyst@northstar.example', 'northstar');
  assert.equal((await call('/api/auth/session', { session: analyst })).response.status, 200);
  assert.equal((await call('/api/auth/logout', { session: analyst, method: 'POST' })).response.status, 200);
  assert.equal((await call('/api/auth/session', { session: analyst })).response.status, 401);
});
