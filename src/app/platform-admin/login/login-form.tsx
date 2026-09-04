"use client";

import { useState } from "react";
import styles from "../platform-admin.module.css";

export function PlatformLoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/platform-admin/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Unable to sign in");
      window.location.assign("/platform-admin");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to sign in");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      {error ? <div className={styles.error} role="alert">{error}</div> : null}
      <div className={styles.field}>
        <label htmlFor="platform-email">Platform owner email</label>
        <input
          id="platform-email"
          className={styles.input}
          type="email"
          autoComplete="username"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="owner@company.com"
          required
        />
      </div>
      <div className={styles.field}>
        <label htmlFor="platform-password">Password</label>
        <input
          id="platform-password"
          className={styles.input}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Enter your password"
          required
        />
      </div>
      <button className={styles.primaryButton} type="submit" disabled={busy} style={{ width: "100%" }}>
        {busy ? "Signing in…" : "Enter control plane"}
      </button>
    </form>
  );
}
