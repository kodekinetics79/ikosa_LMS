/**
 * Which kind of instance is this process?
 *
 * There are exactly two, and the difference is not a matter of degree:
 *
 *   managed  PostgreSQL is the system of record. Missing configuration is a
 *            refusal to start, not a warning. This is what a deployment is.
 *   fixture  The deterministic local datastore, for development and for the
 *            test suites. Seeded accounts with a published password exist.
 *
 * WHY THIS EXISTS AS A SEPARATE DECISION
 *
 * `NODE_ENV` cannot express it. Next.js writes `process.env.NODE_ENV =
 * 'production'` as the fifth line of the standalone `server.js`, before any of
 * this code runs, so a production BUNDLE always reports production regardless of
 * what the caller set. CI tried to select fixture mode with `NODE_ENV=development
 * node .next/standalone/server.js`; that assignment is overwritten and the
 * instance refused to start. A build artifact and a deployment target are
 * different things and need different switches.
 *
 * THE SAFE DIRECTION
 *
 * Fixture mode is never inferred for a production bundle: it must be asked for
 * by name with `IK_RUNTIME_MODE=fixture`. Anything else — including a missing or
 * misspelled value — is managed, so the failure mode of a configuration mistake
 * is an instance that refuses to start, never one that quietly serves demo
 * accounts. And asking for it is refused outright on anything that looks like a
 * real deployment, so the flag cannot be carried into production by an
 * environment file.
 */
export type RuntimeMode = "managed" | "fixture";

export const RUNTIME_MODE_VARIABLE = "IK_RUNTIME_MODE";

type Env = Record<string, string | undefined>;

export function resolveRuntimeMode(env: Env = process.env): RuntimeMode {
  if (env[RUNTIME_MODE_VARIABLE]?.trim() === "fixture") return "fixture";
  // `next dev` is a development instance and needs no ceremony.
  if (env.NODE_ENV !== "production") return "fixture";
  return "managed";
}

/**
 * The signals that say "this is a real deployment". Fixture mode on any of them
 * is a configuration accident, and the right response is to stop.
 */
function deploymentSignals(env: Env): string[] {
  const signals: string[] = [];
  if (env.VERCEL_ENV === "production") signals.push("VERCEL_ENV=production");
  if (env.APP_ENV === "production") signals.push("APP_ENV=production");
  if (env.DATABASE_URL?.trim()) signals.push("DATABASE_URL is set");
  if (env.CONTROL_PLANE_DATABASE_URL?.trim()) signals.push("CONTROL_PLANE_DATABASE_URL is set");
  return signals;
}

/**
 * Throws when fixture mode has been requested somewhere it must never run.
 *
 * A `DATABASE_URL` alongside `IK_RUNTIME_MODE=fixture` is the important case: it
 * is ambiguous rather than merely wrong. Two datastores would be reachable for
 * the same request, and picking either one silently is how a system ends up with
 * two answers to the same question.
 */
export function assertFixtureModeIsPermitted(env: Env = process.env): void {
  if (resolveRuntimeMode(env) !== "fixture") return;
  if (env[RUNTIME_MODE_VARIABLE]?.trim() !== "fixture") return; // plain `next dev`
  const signals = deploymentSignals(env);
  if (signals.length === 0) return;
  throw new Error(
    `Refusing to start: ${RUNTIME_MODE_VARIABLE}=fixture was requested on what looks like a real deployment (${signals.join("; ")}). ` +
    "Fixture mode serves seeded accounts with a published password and must never run against a real datastore.",
  );
}

/** True when PostgreSQL is the system of record and its absence is fatal. */
export function isManagedRuntime(env: Env = process.env): boolean {
  return resolveRuntimeMode(env) === "managed";
}
