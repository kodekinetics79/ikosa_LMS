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
 * This previously declared `/tna` and `/readiness`, neither of which is a route
 * in this application, while the shell carried its own separate list. Two
 * navigation definitions that can disagree is one too many, so the shell now
 * consumes this and maps `icon` onto a component.
 *
 * Every href here MUST correspond to a real route. A link to a page that does
 * not exist is a defect, not a placeholder.
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
] as const;

export type NavItem = (typeof primaryNavigation)[number];
