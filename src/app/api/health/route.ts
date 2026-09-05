import { json } from "@/lib/server/http";
import { postgresConfigured } from "@/lib/server/persistence";
import { resolveRuntimeMode } from "@/lib/server/runtime-mode";
import { readDatabase } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const started = Date.now();
  try {
    const database = await readDatabase();
    return json({
      status: "ok",
      service: "ik-osa",
      persistence: "available",
      // Which kind of instance this is, and which datastore actually answered.
      // `persistence: "available"` was a hardcoded literal, so nothing could
      // tell a managed instance from a fixture one - including the integration
      // suite, which needs to know whether the assessment engine is reachable
      // at all. The values are mode names and disclose no configuration: a
      // connection string, a host and a credential all stay server-side.
      mode: resolveRuntimeMode(),
      datastore: postgresConfigured() ? "postgresql" : "fixture",
      schemaVersion: database.schemaVersion,
      latencyMs: Date.now() - started,
      time: new Date().toISOString(),
    });
  } catch {
    return json({ status: "degraded", service: "ik-osa", persistence: "unavailable", time: new Date().toISOString() }, { status: 503 });
  }
}
