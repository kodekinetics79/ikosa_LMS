export const product = {
  name: "iK Operational Skills Assurance",
  shortName: "iK OSA",
  category: "Operational Skills Assurance",
  promise: "From business change to defensible workforce readiness",
  release: "R0/R1 build"
} as const;

/**
 * Single source of truth for primary navigation.
 *
 * Every href here MUST correspond to a real route. A link to a page that does
 * not exist is a defect, not a placeholder. `/admin` is role-gated by the shell
 * and is rendered only for tenant administrators.
 */
export const primaryNavigation = [
  { href: "/workspace", label: "Workspace home", icon: "home" },
  { href: "/learning", label: "My learning", icon: "learning" },
  { href: "/sessions", label: "Live sessions", icon: "session" },
  { href: "/assessments", label: "Assessments", icon: "assessment" },
  { href: "/catalog", label: "Catalogue", icon: "catalog" },
  { href: "/signals", label: "Signal inbox", icon: "signal" },
  { href: "/studies", label: "TNA studies", icon: "study" },
  { href: "/evidence", label: "Evidence", icon: "evidence" },
  { href: "/interventions", label: "Interventions", icon: "action" },
  { href: "/notifications", label: "Notifications", icon: "bell" },
  { href: "/audit", label: "Audit room", icon: "audit" },
  { href: "/admin", label: "Tenant admin", icon: "admin", tenantAdminOnly: true },
] as const;

export type NavItem = (typeof primaryNavigation)[number];
