export type EvidenceState =
  | "unknown"
  | "declared"
  | "inferred"
  | "completed"
  | "assessed"
  | "observed"
  | "credentialed"
  | "expired";

export type RiskLevel = "critical" | "high" | "medium" | "low";
export type StudyStatus = "draft" | "collecting" | "analysis" | "review" | "approved";
export type InterventionKind =
  | "training"
  | "coaching"
  | "job-aid"
  | "process"
  | "tool"
  | "staffing"
  | "redeployment"
  | "automation";

export interface ScopeContext {
  tenantId: string;
  siteIds: string[];
  roleIds: string[];
  asOf: string;
}

export interface MetricDefinition {
  label: string;
  value: number | string;
  unit: string;
  asOf: string;
  freshness: "current" | "stale" | "unknown";
  confidence: "high" | "medium" | "low" | "unknown";
  numerator?: number;
  denominator?: number;
}

export interface ReadinessReason {
  code: string;
  label: string;
  state: "pass" | "warning" | "block" | "unknown";
  source: string;
  effectiveAt: string;
}
