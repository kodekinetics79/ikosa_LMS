import type { ReactNode } from "react";

export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "success" | "warning" | "danger" | "info" }) {
  return <span className={`badge badge--${tone}`}>{children}</span>;
}

export function Progress({ value, label }: { value: number; label: string }) {
  return <div className="progress" aria-label={`${label}: ${value}%`} role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${value}%` }} /></div>;
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description: string; actions?: ReactNode }) {
  return <header className="page-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1><p>{description}</p></div>{actions && <div className="header-actions">{actions}</div>}</header>;
}

export function EmptyState({ title, text, action }: { title: string; text: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-mark">◇</div><h3>{title}</h3><p>{text}</p>{action}</div>;
}

export function Metric({ label, value, delta, tone = "default", meta }: { label: string; value: string; delta?: string; tone?: "default" | "warning" | "danger" | "success"; meta?: string }) {
  return <article className={`metric metric--${tone}`}><div className="metric-label"><span>{label}</span><button className="icon-button subtle" aria-label={`About ${label}`}>i</button></div><strong>{value}</strong>{delta && <span className="metric-delta">{delta}</span>}{meta && <small>{meta}</small>}</article>;
}

export function PersonAvatar({ initials }: { initials: string }) { return <span className="avatar" aria-hidden="true">{initials}</span>; }

export function Confidence({ value, freshness }: { value: number; freshness: string }) {
  return <div className="confidence"><div><span>Evidence confidence</span><strong>{value}%</strong></div><Progress value={value} label="Evidence confidence" /><small>{freshness}</small></div>;
}
