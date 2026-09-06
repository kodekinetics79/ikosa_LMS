import { PlatformLoginForm } from "./login-form";
import styles from "../platform-admin.module.css";

export default function PlatformAdminLoginPage() {
  const showDevHint = process.env.NODE_ENV !== "production";
  return (
    <main className={styles.loginPage}>
      <section className={styles.loginStory}>
        <div className={styles.brand}>
          <div className={styles.brandMark}>iK</div>
          <span>Platform Control Plane</span>
        </div>
        <div className={styles.storyBody}>
          <h1>Run the learning business, not just the learning portal.</h1>
          <p>
            Provision customers, define their product footprint, issue their first administrator,
            and keep every tenant behind its own security boundary.
          </p>
          <div className={styles.storyFlow} aria-label="Control plane capabilities">
            <span>Tenant provisioning</span><span>Module entitlements</span><span>First-admin setup</span><span>Audit trail</span><span>Capacity controls</span>
          </div>
        </div>
        <small style={{ color: "rgba(255,255,255,.48)" }}>iK Learning & Capability Platform</small>
      </section>
      <section className={styles.loginPanel}>
        <div className={styles.loginCard}>
          <h2>Platform owner sign in</h2>
          <p>This is separate from customer tenant administration and learner access.</p>
          <PlatformLoginForm />
          {showDevHint ? (
            <div className={styles.devHint}>
              Local bootstrap: <strong>owner@platform.local</strong> / <strong>ChangeMe!2026</strong>.
              Production requires PLATFORM_ADMIN_EMAIL, PLATFORM_ADMIN_PASSWORD and PLATFORM_AUTH_SECRET.
            </div>
          ) : null}
        </div>
      </section>
    </main>
  );
}
