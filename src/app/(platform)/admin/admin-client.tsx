"use client";

import { useMemo, useState } from "react";
import type { PlatformRole } from "@/lib/server/domain";
import type { TenantAdminOrgUnit, TenantAdminUser } from "@/lib/server/tenant-admin-store";
import styles from "./admin.module.css";

const ROLE_LABEL: Record<PlatformRole, string> = {
  tenant_admin: "Tenant admin",
  tna_analyst: "TNA analyst",
  manager: "Manager",
  assessor: "Assessor",
  learner: "Learner",
  auditor: "Auditor",
};
const ROLES = Object.keys(ROLE_LABEL) as PlatformRole[];

type ApiProblem = { error?: string; detail?: string; title?: string; errors?: Record<string, string> };

function generatedPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%";
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "?";
}

function messageOf(payload: ApiProblem, fallback: string): string {
  if (payload.detail) return payload.detail;
  if (payload.error) return payload.error;
  if (payload.errors) return Object.values(payload.errors)[0] ?? fallback;
  return payload.title ?? fallback;
}

export function TenantAdminClient({
  initialUsers,
  initialOrganizations,
  csrfToken,
  currentUserId,
}: {
  initialUsers: TenantAdminUser[];
  initialOrganizations: TenantAdminOrgUnit[];
  csrfToken: string;
  currentUserId: string;
}) {
  const [users, setUsers] = useState(initialUsers);
  const [organizations, setOrganizations] = useState(initialOrganizations);
  const [tab, setTab] = useState<"people" | "organization">("people");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<"user" | "org" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [handoff, setHandoff] = useState<{ name: string; email: string; password: string } | null>(null);
  const root = organizations.find((org) => !org.parentId) ?? organizations[0];
  const [userForm, setUserForm] = useState({
    displayName: "",
    email: "",
    orgUnitId: root?.id ?? "",
    password: generatedPassword(),
    roles: ["learner"] as PlatformRole[],
  });
  const [orgForm, setOrgForm] = useState({ name: "", code: "", parentId: root?.id ?? "" });

  const stats = useMemo(() => ({
    activeUsers: users.filter((user) => user.active).length,
    administrators: users.filter((user) => user.active && user.roles.includes("tenant_admin")).length,
    organizations: organizations.length,
    learners: users.filter((user) => user.active && user.roles.includes("learner")).length,
  }), [users, organizations]);

  const filteredUsers = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return users;
    return users.filter((user) => [user.displayName, user.email, user.orgUnitName, ...user.roles].some((value) => value.toLowerCase().includes(term)));
  }, [search, users]);

  const filteredOrganizations = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return organizations;
    return organizations.filter((org) => `${org.name} ${org.code}`.toLowerCase().includes(term));
  }, [search, organizations]);

  function openUser() {
    setError("");
    setHandoff(null);
    setUserForm({ displayName: "", email: "", orgUnitId: root?.id ?? "", password: generatedPassword(), roles: ["learner"] });
    setModal("user");
  }

  function openOrg() {
    setError("");
    setHandoff(null);
    setOrgForm({ name: "", code: "", parentId: root?.id ?? "" });
    setModal("org");
  }

  function toggleRole(role: PlatformRole) {
    setUserForm((current) => ({
      ...current,
      roles: current.roles.includes(role)
        ? current.roles.filter((item) => item !== role)
        : [...current.roles, role],
    }));
  }

  async function createUser(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(userForm),
      });
      const payload = await response.json() as TenantAdminUser & ApiProblem;
      if (!response.ok) throw new Error(messageOf(payload, "Unable to create user"));
      setUsers((current) => [payload, ...current]);
      setHandoff({ name: payload.displayName, email: payload.email, password: userForm.password });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create user");
    } finally {
      setBusy(false);
    }
  }

  async function createOrganization(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/admin/org-units", {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(orgForm),
      });
      const payload = await response.json() as TenantAdminOrgUnit & ApiProblem;
      if (!response.ok) throw new Error(messageOf(payload, "Unable to create organization"));
      setOrganizations((current) => [...current, payload].sort((a, b) => a.path.localeCompare(b.path)));
      setModal(null);
      setTab("organization");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create organization");
    } finally {
      setBusy(false);
    }
  }

  async function toggleActive(user: TenantAdminUser) {
    if (user.id === currentUserId && user.active) return;
    setError("");
    try {
      const response = await fetch("/api/admin/users", {
        method: "PATCH",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify({ userId: user.id, active: !user.active }),
      });
      const payload = await response.json() as ApiProblem;
      if (!response.ok) throw new Error(messageOf(payload, "Unable to update user"));
      setUsers((current) => current.map((item) => item.id === user.id ? { ...item, active: !item.active } : item));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update user");
    }
  }

  return <div className={styles.page}>
    <section className={styles.hero}>
      <div className={styles.heroText}>
        <p className={styles.eyebrow}>Tenant administration</p>
        <h1>People, structure and access.</h1>
        <p>Build the organization learners and managers actually belong to, issue working accounts, and keep delegated access aligned to that structure.</p>
      </div>
      <div className={styles.actions}>
        <button className={styles.secondary} type="button" onClick={openOrg}>+ Add organization</button>
        <button className={styles.primary} type="button" onClick={openUser}>+ Add user</button>
      </div>
    </section>

    {error && !modal ? <div className={styles.error} role="alert">{error}</div> : null}

    <section className={styles.metrics} aria-label="Tenant administration summary">
      <article className={styles.metric}><span>Active users</span><strong>{stats.activeUsers}</strong><small>Accounts able to authenticate</small></article>
      <article className={styles.metric}><span>Learners</span><strong>{stats.learners}</strong><small>Active learner-role accounts</small></article>
      <article className={styles.metric}><span>Organizations</span><strong>{stats.organizations}</strong><small>Units inside your delegated scope</small></article>
      <article className={styles.metric}><span>Tenant admins</span><strong>{stats.administrators}</strong><small>Accounts with tenant-wide administration role</small></article>
    </section>

    <section className={styles.workspace}>
      <header className={styles.workspaceHeader}>
        <div className={styles.tabs} role="tablist" aria-label="Tenant administration views">
          <button className={tab === "people" ? styles.tabActive : styles.tab} type="button" role="tab" aria-selected={tab === "people"} onClick={() => setTab("people")}>People</button>
          <button className={tab === "organization" ? styles.tabActive : styles.tab} type="button" role="tab" aria-selected={tab === "organization"} onClick={() => setTab("organization")}>Organization</button>
        </div>
        <input className={styles.search} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={tab === "people" ? "Search people, email, team or role…" : "Search organizations…"} aria-label="Search tenant administration"/>
      </header>

      {tab === "people" ? (
        filteredUsers.length === 0 ? <div className={styles.empty}><strong>No people match this view.</strong>Add a user or clear the current search.</div> :
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Person</th><th>Organization</th><th>Roles</th><th>Status</th><th>Created</th><th></th></tr></thead>
            <tbody>{filteredUsers.map((user) => <tr key={user.id}>
              <td><div className={styles.person}><div className={styles.avatar}>{initials(user.displayName)}</div><div><strong>{user.displayName}</strong><span>{user.email}</span></div></div></td>
              <td>{user.orgUnitName}</td>
              <td><div className={styles.roles}>{user.roles.map((role) => <span className={styles.role} key={role}>{ROLE_LABEL[role]}</span>)}</div></td>
              <td><span className={user.active ? styles.state : styles.stateOff}>{user.active ? "Active" : "Inactive"}</span></td>
              <td>{user.createdAt.slice(0,10)}</td>
              <td><button className={styles.ghost} type="button" disabled={user.id === currentUserId && user.active} onClick={() => toggleActive(user)}>{user.active ? "Deactivate" : "Activate"}</button></td>
            </tr>)}</tbody>
          </table>
        </div>
      ) : (
        filteredOrganizations.length === 0 ? <div className={styles.empty}><strong>No organizations match this view.</strong>Add a unit or clear the current search.</div> :
        <div className={styles.orgGrid}>{filteredOrganizations.map((org) => {
          const depth = Math.max(0, org.path.split(".").length - 1);
          const parent = organizations.find((candidate) => candidate.id === org.parentId);
          return <article className={styles.orgCard} key={org.id}>
            <small>{depth === 0 ? "Tenant root" : `Level ${depth + 1}`}</small>
            <strong>{org.name}</strong>
            <span>{org.code}{parent ? ` · under ${parent.name}` : " · root organization"}</span>
            <div className={styles.orgMeta}><span>{org.memberCount} active {org.memberCount === 1 ? "member" : "members"}</span><span>{org.path.split(".").length} level path</span></div>
          </article>;
        })}</div>
      )}
    </section>

    {modal ? <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setModal(null); }}>
      <section className={styles.modal} role="dialog" aria-modal="true" aria-labelledby="admin-modal-title">
        <header className={styles.modalHeader}>
          <div><h2 id="admin-modal-title">{modal === "user" ? (handoff ? "User ready" : "Add a user") : "Add an organization"}</h2><p>{modal === "user" ? "Create a real tenant account with delegated organizational scope." : "Extend the tenant hierarchy below an organization already in your scope."}</p></div>
          <button className={styles.iconButton} type="button" onClick={() => setModal(null)} aria-label="Close">×</button>
        </header>
        {modal === "user" ? (
          <div className={styles.modalBody}>
            {handoff ? <div className={styles.success}>
              <strong>{handoff.name}</strong> is ready to sign in.<br/>
              Email: <strong>{handoff.email}</strong><br/>
              Temporary password: <strong>{handoff.password}</strong><br/><br/>
              <button className={styles.secondary} type="button" onClick={() => navigator.clipboard.writeText(`Email: ${handoff.email}\nTemporary password: ${handoff.password}`)}>Copy credentials</button>
            </div> : <form onSubmit={createUser}>
              {error ? <div className={styles.error} role="alert">{error}</div> : null}
              <div className={styles.grid2}>
                <div className={styles.field}><label htmlFor="user-name">Full name</label><input id="user-name" className={styles.input} value={userForm.displayName} onChange={(event) => setUserForm((current) => ({ ...current, displayName: event.target.value }))} required/></div>
                <div className={styles.field}><label htmlFor="user-email">Work email</label><input id="user-email" className={styles.input} type="email" value={userForm.email} onChange={(event) => setUserForm((current) => ({ ...current, email: event.target.value }))} required/></div>
                <div className={styles.field}><label htmlFor="user-org">Organization</label><select id="user-org" className={styles.select} value={userForm.orgUnitId} onChange={(event) => setUserForm((current) => ({ ...current, orgUnitId: event.target.value }))} required>{organizations.map((org) => <option key={org.id} value={org.id}>{org.name} · {org.code}</option>)}</select></div>
                <div className={styles.field}><label htmlFor="user-password">Temporary password</label><input id="user-password" className={styles.input} value={userForm.password} onChange={(event) => setUserForm((current) => ({ ...current, password: event.target.value }))} minLength={12} required/></div>
              </div>
              <div className={styles.field}><label>Roles</label><div className={styles.roleGrid}>{ROLES.map((role) => <div className={styles.roleChoice} key={role}><input id={`role-${role}`} type="checkbox" checked={userForm.roles.includes(role)} onChange={() => toggleRole(role)}/><label htmlFor={`role-${role}`}>{ROLE_LABEL[role]}</label></div>)}</div></div>
              <div className={styles.formFooter}><small>The user inherits delegated scope from the selected organization. Accounts can be deactivated later; deactivation revokes their active sessions.</small><button className={styles.primary} type="submit" disabled={busy}>{busy ? "Creating…" : "Create user"}</button></div>
            </form>}
          </div>
        ) : <form className={styles.modalBody} onSubmit={createOrganization}>
          {error ? <div className={styles.error} role="alert">{error}</div> : null}
          <div className={styles.grid2}>
            <div className={styles.field}><label htmlFor="org-name">Organization name</label><input id="org-name" className={styles.input} value={orgForm.name} onChange={(event) => setOrgForm((current) => ({ ...current, name: event.target.value }))} required/></div>
            <div className={styles.field}><label htmlFor="org-code">Code</label><input id="org-code" className={styles.input} value={orgForm.code} onChange={(event) => setOrgForm((current) => ({ ...current, code: event.target.value.toUpperCase() }))} placeholder="ENG" required/></div>
          </div>
          <div className={styles.field}><label htmlFor="org-parent">Parent organization</label><select id="org-parent" className={styles.select} value={orgForm.parentId} onChange={(event) => setOrgForm((current) => ({ ...current, parentId: event.target.value }))} required>{organizations.map((org) => <option key={org.id} value={org.id}>{org.name} · {org.code}</option>)}</select></div>
          <div className={styles.formFooter}><small>The new unit is created below the selected parent and remains inside the current administrator&apos;s delegated scope.</small><button className={styles.primary} type="submit" disabled={busy}>{busy ? "Creating…" : "Create organization"}</button></div>
        </form>}
      </section>
    </div> : null}
  </div>;
}
