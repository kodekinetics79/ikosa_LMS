import { json } from "@/lib/server/http";
import { resetDevelopmentDatabase } from "@/lib/server/store";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (process.env.NODE_ENV === "production" || process.env.IK_ENABLE_DEV_RESET !== "true") return json({ error: "Not found" }, { status: 404 });
  if (request.headers.get("x-dev-reset-key") !== process.env.IK_DEV_RESET_KEY) return json({ error: "Forbidden" }, { status: 403 });
  await resetDevelopmentDatabase();
  return json({ ok: true });
}
