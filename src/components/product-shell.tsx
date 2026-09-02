"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { Icons } from "./icons";
import { BackendTruth } from "./backend-truth";
import { SignOut } from "./sign-out";
import { primaryNavigation } from "@/lib/product";

// Navigation is declared once in @/lib/product; the shell only maps the icon
// key onto a component, so the two can never drift apart.
const iconFor: Record<string, (props: React.SVGProps<SVGSVGElement>) => React.ReactElement> = {
  home: Icons.home, signal: Icons.signal, study: Icons.study, learning: Icons.learning,
  catalog: Icons.catalog, evidence: Icons.evidence, action: Icons.action, audit: Icons.audit,
  bell: Icons.bell,
};
const nav = primaryNavigation.map((item) => ({ ...item, icon: iconFor[item.icon] ?? Icons.home }));

const roleLabels: Record<string, string> = {
  tenant_admin: "Tenant administrator",
  tna_analyst: "TNA analyst",
  manager: "Manager",
  assessor: "Assessor",
  learner: "Learner",
  auditor: "Auditor",
};

export type ShellIdentity = {
  displayName: string;
  email: string;
  roles: string[];
  tenantName: string;
  organizationCount: number;
};

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("") || "?";
}

export function ProductShell({ children, identity }: { children: ReactNode; identity: ShellIdentity }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [rtl, setRtl] = useState(false);
  useEffect(() => { document.documentElement.dir = rtl ? "rtl" : "ltr"; document.documentElement.lang = rtl ? "ar" : "en"; }, [rtl]);

  const liveKind = path.startsWith("/studies") ? (path.endsWith("/gaps") ? "gaps" : "tna") : path.startsWith("/evidence") ? "evidence" : path.startsWith("/interventions") ? "interventions" : path.startsWith("/audit") ? "audit" : null;
  const roleLabel = roleLabels[identity.roles[0] ?? ""] ?? "Workspace member";

  return <div className="app-shell" dir={rtl ? "rtl" : "ltr"}>
    <a href="#main-content" className="skip-link">Skip to main content</a>
    <aside className={`sidebar ${open ? "sidebar--open" : ""}`} aria-label="Primary navigation">
      <div className="brand"><span className="brand-mark">iK</span><span><strong>Assure</strong><small>Operational Skills</small></span><button className="icon-button mobile-only" onClick={() => setOpen(false)} aria-label="Close navigation"><Icons.close /></button></div>
      <div className="workspace-switch"><span className="workspace-logo">{initials(identity.tenantName)}</span><span><small>Workspace</small><strong>{identity.tenantName}</strong></span><Icons.chevron /></div>
      <nav>{nav.map(item => { const active = item.href === "/" ? path === "/" : path.startsWith(item.href); const Icon = item.icon; return <Link key={item.href} href={item.href} className={active ? "active" : ""} aria-current={active ? "page" : undefined} onClick={() => setOpen(false)}><Icon /><span>{item.label}</span></Link>; })}</nav>
      <div className="sidebar-foot"><div className="trust-state"><Icons.shield /><span><strong>Trusted data</strong><small>All sources healthy</small></span><i /></div><div className="profile"><span className="avatar">{initials(identity.displayName)}</span><span><strong>{identity.displayName}</strong><small>{roleLabel}</small></span><SignOut /></div></div>
    </aside>
    <div className="workspace">
      <header className="topbar">
        <button className="icon-button mobile-only" onClick={() => setOpen(true)} aria-label="Open navigation"><Icons.menu /></button>
        <button className="scope-button"><span>Delegated scope</span><strong>{identity.tenantName} · {identity.organizationCount} organizational {identity.organizationCount === 1 ? "unit" : "units"}</strong><Icons.chevron /></button>
        <button className="search-button"><Icons.search /><span>Search people, roles, evidence…</span><kbd>⌘ K</kbd></button>
        <div className="topbar-actions"><button className="icon-button" onClick={() => setRtl(!rtl)} aria-label="Switch language direction"><Icons.globe /><span>{rtl ? "EN" : "AR"}</span></button><Link className="icon-button" href="/notifications" aria-label="Notifications"><Icons.bell /></Link></div>
      </header>
      <main id="main-content" tabIndex={-1}>{children}{liveKind && <div className="live-data-slot"><BackendTruth kind={liveKind} /></div>}</main>
    </div>
    {open && <button className="scrim" onClick={() => setOpen(false)} aria-label="Close navigation overlay" />}
  </div>;
}
