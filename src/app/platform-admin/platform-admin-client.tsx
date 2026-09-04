"use client";

import { useMemo, useState } from "react";
import { Building2, ExternalLink, LayoutDashboard, LogOut, Plus, Power, RotateCcw, ShieldCheck, Users, X } from "lucide-react";
import type { PlatformModule, PlatformOperator, PlatformTenant, TenantKind, TenantState } from "@/lib/server/platform-admin";
import styles from "./platform-admin.module.css";

const moduleCopy: Record<PlatformModule, string> = {
  learn: "Courses & learning",
  assess: "Exams & grading",
  live: "Live classrooms",
  ai: "AI tutor & authoring",
  skills: "Skills intelligence",
  tna: "Training needs",
  evidence: "Capability evidence",
  credentials: "Credentials",
  insights: "Analytics",
};

const allModules = Object.keys(moduleCopy) as PlatformModule[];

function makePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "TN";
}

export function PlatformAdminClient({ operator, csrfToken, initialTenants }: {
  operator: PlatformOperator;
  csrfToken: string;
  initialTenants: PlatformTenant[];
}) {
  const [tenants, setTenants] = useState(initialTenants);
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [stateChanging, setStateChanging] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [credentials, setCredentials] = useState<{ tenant: string; slug: string; email: string; password: string } | null>(null);
  const [form, setForm] = useState({
    name: "",
    slug: "",
    tenantKind: "corporate" as TenantKind,
    homeRegion: "us-east",
    locale: "en-US",
    planCode: "pilot",
    seatLimit: 500,
    storageGb: 100,
    aiMonthlyCredits: 50000,
    trialDays: 30,
    adminName: "",
    adminEmail: "",
    adminPassword: makePassword(),
    enabledModules: [...allModules] as PlatformModule[],
  });

  const stats = useMemo(() => ({
    total: tenants.length,
    active: tenants.filter((tenant) => tenant.state === "active").length,
    trial: tenants.filter((tenant) => tenant.state === "trial").length,
    suspended: tenants.filter((tenant) => tenant.state === "suspended").length,
    seats: tenants.reduce((sum, tenant) => sum + tenant.seatLimit, 0),
  }), [tenants]);

  function update<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  function toggleModule(module: PlatformModule) {
    setForm((current) => ({
      ...current,
      enabledModules: current.enabledModules.includes(module)
        ? current.enabledModules.filter((item) => item !== module)
        : [...current.enabledModules, module],
    }));
  }

  function openCreate() {
    setError("");
    setCredentials(null);
    setForm((current) => ({ ...current, adminPassword: makePassword() }));
    setShowCreate(true);
  }

  async function createTenant(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/platform-admin/tenants", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(form),
      });
      const payload = await response.json() as { tenant?: PlatformTenant; error?: string };
      if (!response.ok || !payload.tenant) throw new Error(payload.error ?? "Tenant creation failed");
      setTenants((current) => [payload.tenant!, ...current]);
      setCredentials({ tenant: payload.tenant.name, slug: payload.tenant.slug, email: form.adminEmail, password: form.adminPassword });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tenant creation failed");
    } finally {
      setBusy(false);
    }
  }

  async function changeTenantState(tenant: PlatformTenant, nextState: TenantState) {
    if (nextState === "suspended") {
      const approved = window.confirm(`Suspend ${tenant.name}? Existing tenant sessions will be revoked immediately.`);
      if (!approved) return;
    }
    setStateChanging(tenant.id);
    setError("");
    try {
      const response = await fetch("/api/platform-admin/tenants", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ tenantId: tenant.id, state: nextState }),
      });
      const payload = await response.json() as { state?: TenantState; error?: string };
      if (!response.ok || !payload.state) throw new Error(payload.error ?? "Tenant state change failed");
      setTenants((current) => current.map((item) => item.id === tenant.id ? { ...item, state: payload.state! } : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Tenant state change failed");
    } finally {
      setStateChanging(null);
    }
  }

  async function logout() {
    await fetch("/api/platform-admin/auth/logout", { method: "POST", headers: { "x-csrf-token": csrfToken } });
    window.location.assign("/platform-admin/login");
  }

  return (
    <div className={styles.page}>
      <div className={styles.shell}>
        <aside className={styles.sidebar}>
          <div className={styles.brand}><div className={styles.brandMark}>iK</div><span>Control Plane</span></div>
          <nav className={styles.nav} aria-label="Platform admin navigation">
            <a className={styles.navItemActive} href="#overview"><LayoutDashboard size={17}/><span>Overview</span></a>
            <a className={styles.navItem} href="#tenants"><Building2 size={17}/><span>Tenants</span></a>
            <a className={styles.navItem} href="/" target="_blank" rel="noreferrer"><ExternalLink size={17}/><span>Learning platform</span></a>
          </nav>
          <div className={styles.sidebarBottom}>
            <div className={styles.owner}><strong>{operator.displayName}</strong><span>{operator.email}</span></div>
          </div>
        </aside>

        <main className={styles.main} id="overview">
          <div className={styles.topbar}>
            <div className={styles.heading}>
              <h1>Tenant command center</h1>
              <p>Provision customers, control their product footprint and hand off a working administrator account.</p>
            </div>
            <div className={styles.topActions}>
              <button className={styles.secondaryButton} type="button" onClick={logout}><LogOut size={15} style={{ verticalAlign: "-3px", marginRight: 7 }}/>Sign out</button>
              <button className={styles.primaryButton} type="button" onClick={openCreate}><Plus size={16} style={{ verticalAlign: "-3px", marginRight: 7 }}/>New tenant</button>
            </div>
          </div>

          {error ? <div className={styles.error} role="alert">{error}</div> : null}

          <section className={styles.metrics} aria-label="Tenant portfolio summary">
            <div className={styles.metric}><div className={styles.metricLabel}>Managed tenants</div><div className={styles.metricValue}>{stats.total}</div><div className={styles.metricSub}>Commercial control-plane records</div></div>
            <div className={styles.metric}><div className={styles.metricLabel}>Active</div><div className={styles.metricValue}>{stats.active}</div><div className={styles.metricSub}>Beyond trial state</div></div>
            <div className={styles.metric}><div className={styles.metricLabel}>Pilot / trial</div><div className={styles.metricValue}>{stats.trial}</div><div className={styles.metricSub}>{stats.suspended ? `${stats.suspended} suspended` : "Controlled customer validation"}</div></div>
            <div className={styles.metric}><div className={styles.metricLabel}>Provisioned seats</div><div className={styles.metricValue}>{stats.seats.toLocaleString()}</div><div className={styles.metricSub}>Across the managed portfolio</div></div>
          </section>

          <section className={styles.section} id="tenants">
            <div className={styles.sectionHeader}>
              <div><h2>Customer portfolio</h2><p>Only tenants explicitly brought under the SaaS control plane appear here.</p></div>
              <ShieldCheck size={20} color="#6655ef" aria-hidden="true"/>
            </div>
            {tenants.length === 0 ? (
              <div className={styles.empty}><strong>No managed tenants yet</strong>Create your first pilot/customer tenant and the system will provision its root organization and first administrator atomically.</div>
            ) : (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead><tr><th>Tenant</th><th>Type</th><th>Status</th><th>Plan</th><th>Seats</th><th>First admin</th><th>Modules</th><th>Lifecycle</th></tr></thead>
                  <tbody>
                    {tenants.map((tenant) => (
                      <tr key={tenant.id}>
                        <td><div className={styles.tenantName}><div className={styles.tenantAvatar}>{initials(tenant.name)}</div><div><strong>{tenant.name}</strong><span>{tenant.slug} · {tenant.homeRegion}</span></div></div></td>
                        <td>{tenant.tenantKind.replace("_", " ")}</td>
                        <td><span className={styles.status}>{tenant.state}</span></td>
                        <td>{tenant.planCode}</td>
                        <td><Users size={13} style={{ verticalAlign: "-2px", marginRight: 5 }}/>{tenant.seatLimit.toLocaleString()}</td>
                        <td>{tenant.firstAdminEmail ?? "—"}</td>
                        <td><div className={styles.modules}>{tenant.enabledModules.slice(0, 4).map((module) => <span className={styles.moduleTag} key={module}>{module}</span>)}{tenant.enabledModules.length > 4 ? <span className={styles.moduleTag}>+{tenant.enabledModules.length - 4}</span> : null}</div></td>
                        <td>
                          <div style={{ display: "flex", gap: 7, flexWrap: "wrap" }}>
                            {tenant.state === "suspended" ? (
                              <button className={styles.secondaryButton} type="button" disabled={stateChanging === tenant.id} onClick={() => changeTenantState(tenant, "active")}><RotateCcw size={13} style={{ verticalAlign: "-2px", marginRight: 5 }}/>{stateChanging === tenant.id ? "Working…" : "Reactivate"}</button>
                            ) : (
                              <button className={styles.secondaryButton} type="button" disabled={stateChanging === tenant.id} onClick={() => changeTenantState(tenant, "suspended")}><Power size={13} style={{ verticalAlign: "-2px", marginRight: 5 }}/>{stateChanging === tenant.id ? "Working…" : "Suspend"}</button>
                            )}
                            {tenant.state === "trial" ? <button className={styles.secondaryButton} type="button" disabled={stateChanging === tenant.id} onClick={() => changeTenantState(tenant, "active")}>Activate</button> : null}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </main>
      </div>

      {showCreate ? (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowCreate(false); }}>
          <div className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="new-tenant-title">
            <div className={styles.modalHeader}>
              <div><h2 id="new-tenant-title">{credentials ? "Tenant ready" : "Provision a customer"}</h2><p>{credentials ? "Capture these credentials before closing this window." : "Creates the tenant, commercial profile, root organization and first tenant administrator in one transaction."}</p></div>
              <button className={styles.iconButton} type="button" onClick={() => setShowCreate(false)} aria-label="Close"><X size={18}/></button>
            </div>
            {credentials ? (
              <div className={styles.formBody}>
                <div style={{ padding: 22, borderRadius: 18, background: "linear-gradient(135deg,#f1efff,#ebfbf7)", border: "1px solid #dcd8ff" }}>
                  <strong style={{ display: "block", fontSize: 20, letterSpacing: "-.025em" }}>{credentials.tenant}</strong>
                  <p style={{ color: "#697086", fontSize: 13, lineHeight: 1.6 }}>The customer can now sign in through the standard tenant login using the tenant slug and administrator credentials below.</p>
                  <div className={styles.formGrid}>
                    <div className={styles.field}><label>Tenant slug</label><input className={styles.input} readOnly value={credentials.slug}/></div>
                    <div className={styles.field}><label>Administrator email</label><input className={styles.input} readOnly value={credentials.email}/></div>
                  </div>
                  <div className={styles.field}><label>Temporary password</label><input className={styles.input} readOnly value={credentials.password}/></div>
                  <button className={styles.primaryButton} type="button" onClick={() => navigator.clipboard.writeText(`Tenant: ${credentials.slug}\nEmail: ${credentials.email}\nTemporary password: ${credentials.password}`)}>Copy handoff credentials</button>
                </div>
              </div>
            ) : (
              <form className={styles.formBody} onSubmit={createTenant}>
                {error ? <div className={styles.error} role="alert">{error}</div> : null}
                <section className={styles.formSection}>
                  <h3>Customer identity</h3>
                  <div className={styles.formGrid}>
                    <div className={styles.field}><label htmlFor="tenant-name">Organization name</label><input id="tenant-name" className={styles.input} value={form.name} onChange={(event) => { const name = event.target.value; setForm((current) => ({ ...current, name, slug: current.slug ? current.slug : slugify(name) })); }} required/></div>
                    <div className={styles.field}><label htmlFor="tenant-slug">Tenant slug</label><input id="tenant-slug" className={styles.input} value={form.slug} onChange={(event) => update("slug", slugify(event.target.value))} required/></div>
                    <div className={styles.field}><label htmlFor="tenant-kind">Customer type</label><select id="tenant-kind" className={styles.select} value={form.tenantKind} onChange={(event) => update("tenantKind", event.target.value as TenantKind)}><option value="corporate">Corporate</option><option value="education">School / University</option><option value="training_provider">Training provider</option><option value="ngo">NGO / Mission learning</option></select></div>
                    <div className={styles.field}><label htmlFor="tenant-region">Home data region</label><select id="tenant-region" className={styles.select} value={form.homeRegion} onChange={(event) => update("homeRegion", event.target.value)}><option value="us-east">US East</option><option value="us-west">US West</option><option value="ca-central">Canada Central</option><option value="eu-west">EU West</option></select></div>
                  </div>
                </section>

                <section className={styles.formSection}>
                  <h3>Commercial envelope</h3>
                  <div className={styles.formGrid}>
                    <div className={styles.field}><label htmlFor="tenant-plan">Plan</label><select id="tenant-plan" className={styles.select} value={form.planCode} onChange={(event) => update("planCode", event.target.value)}><option value="pilot">Pilot</option><option value="growth">Growth</option><option value="enterprise">Enterprise</option></select></div>
                    <div className={styles.field}><label htmlFor="tenant-trial">Trial days</label><input id="tenant-trial" className={styles.input} type="number" min="0" max="180" value={form.trialDays} onChange={(event) => update("trialDays", Number(event.target.value))}/></div>
                    <div className={styles.field}><label htmlFor="tenant-seats">Seat limit</label><input id="tenant-seats" className={styles.input} type="number" min="1" value={form.seatLimit} onChange={(event) => update("seatLimit", Number(event.target.value))}/></div>
                    <div className={styles.field}><label htmlFor="tenant-storage">Storage (GB)</label><input id="tenant-storage" className={styles.input} type="number" min="1" value={form.storageGb} onChange={(event) => update("storageGb", Number(event.target.value))}/></div>
                    <div className={styles.field}><label htmlFor="tenant-ai">Monthly AI credits</label><input id="tenant-ai" className={styles.input} type="number" min="0" value={form.aiMonthlyCredits} onChange={(event) => update("aiMonthlyCredits", Number(event.target.value))}/></div>
                    <div className={styles.field}><label htmlFor="tenant-locale">Default locale</label><select id="tenant-locale" className={styles.select} value={form.locale} onChange={(event) => update("locale", event.target.value)}><option value="en-US">English (US)</option><option value="en-CA">English (Canada)</option><option value="fr-CA">French (Canada)</option><option value="es-US">Spanish (US)</option></select></div>
                  </div>
                </section>

                <section className={styles.formSection}>
                  <h3>Product modules</h3>
                  <div className={styles.moduleGrid}>
                    {allModules.map((module) => (
                      <div className={styles.moduleChoice} key={module}>
                        <input id={`module-${module}`} type="checkbox" checked={form.enabledModules.includes(module)} onChange={() => toggleModule(module)}/>
                        <label htmlFor={`module-${module}`}><strong>{module}</strong><span>{moduleCopy[module]}</span></label>
                      </div>
                    ))}
                  </div>
                </section>

                <section className={styles.formSection}>
                  <h3>First tenant administrator</h3>
                  <div className={styles.formGrid}>
                    <div className={styles.field}><label htmlFor="admin-name">Administrator name</label><input id="admin-name" className={styles.input} value={form.adminName} onChange={(event) => update("adminName", event.target.value)} required/></div>
                    <div className={styles.field}><label htmlFor="admin-email">Administrator email</label><input id="admin-email" className={styles.input} type="email" value={form.adminEmail} onChange={(event) => update("adminEmail", event.target.value)} required/></div>
                  </div>
                  <div className={styles.field}><label htmlFor="admin-password">Temporary password</label><input id="admin-password" className={styles.input} value={form.adminPassword} onChange={(event) => update("adminPassword", event.target.value)} minLength={12} required/></div>
                </section>

                <div className={styles.formFooter}>
                  <p>The tenant is not created until every dependent record can be committed successfully. Partial customer setup is rolled back.</p>
                  <button className={styles.primaryButton} type="submit" disabled={busy}>{busy ? "Provisioning…" : "Provision tenant"}</button>
                </div>
              </form>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
