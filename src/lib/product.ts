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
  { href: "/", label: "Readiness home", icon: "home" },
  { href: "/signals", label: "Signal inbox", icon: "signal" },
  { href: "/studies", label: "TNA studies", icon: "study" },
  { href: "/learning", label: "My learning", icon: "learning" },
  { href: "/catalog", label: "Catalogue", icon: "catalog" },
  { href: "/notifications", label: "Notifications", icon: "bell" },
  { href: "/evidence", label: "Evidence", icon: "evidence" },
  { href: "/interventions", label: "Interventions", icon: "action" },
  { href: "/audit", label: "Audit room", icon: "audit" },
  { href: "/admin", label: "Tenant admin", icon: "admin", tenantAdminOnly: true },
] as const;

export type NavItem = (typeof primaryNavigation)[number];
