import { AuthError } from "./auth";

export function requestId(request: Request): string {
  return request.headers.get("x-request-id") ?? crypto.randomUUID();
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function problem(error: unknown, id: string): Response {
  if (error instanceof AuthError) return json({ error: error.message, requestId: id }, { status: error.status });
  if (error instanceof ValidationError) return json({ error: error.message, fields: error.fields, requestId: id }, { status: 400 });
  console.error("API request failed", { requestId: id, error });
  return json({ error: "An unexpected error occurred", requestId: id }, { status: 500 });
}

export class ValidationError extends Error {
  constructor(message: string, public fields: Record<string, string>) { super(message); }
}

export async function objectBody(request: Request): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = await request.json(); } catch { throw new ValidationError("Request body must be valid JSON", { body: "Invalid JSON" }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ValidationError("Request body must be an object", { body: "Expected object" });
  return value as Record<string, unknown>;
}

export function requiredString(body: Record<string, unknown>, field: string, max = 500): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) throw new ValidationError("Validation failed", { [field]: "Required" });
  if (value.trim().length > max) throw new ValidationError("Validation failed", { [field]: `Must be ${max} characters or fewer` });
  return value.trim();
}

export function optionalEnum<T extends string>(body: Record<string, unknown>, field: string, allowed: readonly T[], fallback: T): T {
  const value = body[field] ?? fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new ValidationError("Validation failed", { [field]: `Must be one of: ${allowed.join(", ")}` });
  return value as T;
}
