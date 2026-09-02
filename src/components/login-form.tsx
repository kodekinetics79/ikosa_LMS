"use client";

import { useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export function LoginForm() {
  const router = useRouter();
  const search = useSearchParams();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    const data = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // No tenant slug: the server resolves the tenant from the identity.
        // Pinning it here made every workspace but one unreachable from the UI.
        body: JSON.stringify({ email: data.get("email"), password: data.get("password") }),
      });
      if (!response.ok) {
        setError("Unable to sign in. Check your credentials and try again.");
        return;
      }
      // Return the person to wherever the proxy interrupted them, but only to a
      // path on this origin so the parameter cannot become an open redirect.
      const requested = search.get("next");
      const destination = requested && requested.startsWith("/") && !requested.startsWith("//") ? requested : "/";
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
      <p>Use your organization account to continue.</p>
      {error && <div className="login-error" role="alert">{error}</div>}
      <label>Work email
        <input type="email" name="email" autoComplete="email" required />
      </label>
      <label><span>Password <a href="#">Forgot password?</a></span>
        <input type="password" name="password" autoComplete="current-password" required />
      </label>
      <button className="button primary full" type="submit" disabled={pending}>{pending ? "Signing in…" : "Sign in securely"}</button>
      <div className="or"><span>or</span></div>
      <button className="button secondary full" type="button"><span className="sso-mark">S</span>Continue with enterprise SSO</button>
      <small className="legal">By continuing, you agree to your organization’s acceptable-use and privacy policies.</small>
    </form>
  );
}
