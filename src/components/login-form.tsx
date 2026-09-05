"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const initialTenant = (search.get("tenant") ?? "").trim().toLowerCase();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Tenant-first: the workspace is part of the credential, not a
        // fallback. The server resolves the slug to a tenant before it looks a
        // user up, so the same address in two workspaces is two accounts.
        body: JSON.stringify({
          tenantSlug: (data.get("tenantSlug") as string | null)?.trim().toLowerCase(),
          email: data.get("email"),
          password: data.get("password"),
        }),
      });
      if (!response.ok) {
        setError("Unable to sign in. Check your workspace and credentials, then try again.");
        return;
      }
      const requested = search.get("next");
      const destination = requested && requested.startsWith("/") && !requested.startsWith("//") ? requested : "/workspace";
      router.push(destination);
      router.refresh();
    } catch {
      setError("Unable to sign in right now. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="login-form" method="post" action="/api/auth/login" onSubmit={submit}>
      <div className="mobile-login-brand"><span className="brand-mark">iK</span><strong>Assure</strong></div>
      <p className="eyebrow">Welcome back</p>
      <h2>Sign in to your workspace</h2>
      <p>Use the workspace ID provided by your organization administrator.</p>
      {error && <div className="login-error" role="alert">{error}</div>}
      <label>Workspace
        <input type="text" name="tenantSlug" autoComplete="organization" defaultValue={initialTenant} placeholder="your-organization" pattern="[a-z0-9][a-z0-9-]{1,62}" required />
      </label>
      <label>Work email
        <input type="email" name="email" autoComplete="email" required />
      </label>
      <label>Password
        <input type="password" name="password" autoComplete="current-password" required />
      </label>
      <button className="button primary full" type="submit" disabled={pending}>{pending ? "Signing in…" : "Sign in securely"}</button>
      <small className="legal">Need a password reset? Contact your tenant administrator. Enterprise SSO will appear here only after your organization has configured it.</small>
    </form>
  );
}
