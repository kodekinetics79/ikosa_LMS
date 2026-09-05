/**
 * The organizational-path round trip.
 *
 * Delegated scope is the product's single most load-bearing filter: it decides
 * which organizations, people, studies, gaps, courses and assessments a signed-in
 * user can see at all. It survives two representations on every request:
 *
 *   osa.org_units.path / osa.users.delegated_org_paths   ltree    `a.b`
 *   OrgUnit.path / Principal.delegatedOrgPaths           domain   `/a/b`
 *
 * `ltreeToPath` converts one way and `pathToLtree` the other, and the scope is
 * only correct if they are inverses. They are — but ONLY while every ltree
 * label is already a uuid, because `pathToLtree` runs each segment through
 * `toStorageId`, which maps anything that is not a uuid through uuid v5 and so
 * returns a different value.
 *
 * That is not a theoretical constraint. `createTenantOrgUnit` used to mint the
 * label `org_<uuid with underscores>`, which broke the round trip: every user
 * created under a newly created organization got a delegated scope that matched
 * no row, and signed in to a workspace that looked legitimately empty. Nothing
 * errored, which is what made it dangerous.
 *
 * These tests are pure — no database, no driver — so they hold the invariant
 * for every engineer on every run.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { isUuid, ltreeToPath, pathToLtree, toStorageId } from "../../src/lib/server/db/ids.ts";

test("a uuid-labelled ltree path survives the domain round trip unchanged", () => {
  const root = randomUUID();
  const child = randomUUID();
  const grandchild = randomUUID();
  const ltree = `${root}.${child}.${grandchild}`;

  assert.equal(ltreeToPath(ltree), `/${root}/${child}/${grandchild}`);
  assert.equal(pathToLtree(ltreeToPath(ltree)), ltree);
});

test("a label that is not a uuid does NOT survive the round trip", () => {
  // The defect, stated as a property rather than as a story. If this ever
  // starts passing as an identity, `toStorageId` has changed and
  // `createTenantOrgUnit` may mint whatever label it likes.
  const parent = randomUUID();
  const created = randomUUID();
  const legacyStyleLabel = `org_${created.replaceAll("-", "_")}`;
  const ltree = `${parent}.${legacyStyleLabel}`;

  assert.equal(isUuid(legacyStyleLabel), false);
  assert.notEqual(pathToLtree(ltreeToPath(ltree)), ltree);
  // Specifically: it becomes a uuid v5 of the label, which addresses no row.
  assert.equal(pathToLtree(ltreeToPath(ltree)), `${parent}.${toStorageId(legacyStyleLabel)}`);
});

test("the child path a new organization is given keeps the invariant", () => {
  // Mirrors createTenantOrgUnit: parent ltree + "." + the new row's own uuid.
  const parentPath = `${randomUUID()}.${randomUUID()}`;
  const id = randomUUID();
  const childPath = `${parentPath}.${id}`;

  assert.equal(pathToLtree(ltreeToPath(childPath)), childPath);
  // And the last label is addressable as the row's primary key, which is what
  // makes `path <@ ANY(scope)` and `id = $1` describe the same organization.
  assert.equal(childPath.split(".").at(-1), id);
});

test("an empty scope converts to an empty ltree scope, not to a match-everything one", () => {
  // `<@ ANY('{}')` is false for every row. A user with no delegated paths must
  // see nothing; the dangerous failure would be converting to a value that
  // matches all rows.
  assert.deepEqual(pathToLtree(""), "");
  assert.equal(ltreeToPath(""), "");
});
