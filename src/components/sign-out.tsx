"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * The application had no way to sign out, despite /api/auth/logout existing and
 * invalidating the server-side session. On a shared field workstation that
 * leaves a session open for whoever sits down next.
 */
export function SignOut() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      // Navigate regardless: if the request failed the cookie may still be
      // live, and the login screen is the honest place to land.
      router.push("/login");
      router.refresh();
    }
  }

  return (
    <button type="button" className="text-button" onClick={signOut} disabled={pending}>
      {pending ? "Signing out…" : "Sign out"}
    </button>
  );
}
