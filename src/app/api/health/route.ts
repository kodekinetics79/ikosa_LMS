import { json } from "@/lib/server/http";
import { readDatabase } from "@/lib/server/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const started = Date.now();
  try {
    const database = await readDatabase();
    return json({ status: "ok", service: "ik-osa", persistence: "available", schemaVersion: database.schemaVersion, latencyMs: Date.now() - started, time: new Date().toISOString() });
  } catch {
    return json({ status: "degraded", service: "ik-osa", persistence: "unavailable", time: new Date().toISOString() }, { status: 503 });
  }
}
